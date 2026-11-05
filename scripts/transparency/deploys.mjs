#!/usr/bin/env node
// The deploy watcher's check, run by .github/workflows/transparency.yml (scheduled hourly, often hours late, and after each deploy):
// which image Fly says the live machine runs, whether GitHub built and signed
// that exact image with deploy.yml from a commit that is still on main, and
// when the machine started. It also checks the machine's settings and secret
// names, since those can change what runs without a new image: the start
// command, extra containers, and environment variables such as NODE_OPTIONS.
// Writes deploys/current.json, adds a line to deploys/log.jsonl when anything
// changed (including every start Fly reports), and exits 1 (writing
// deploys/PROBLEM.md) when something is wrong, 2 when GitHub couldn't be
// asked, or 3 when this script itself went wrong.
//   node scripts/transparency/deploys.mjs <machines.json> <version.json> <secrets.json> <fly.toml> <folder>
// machines.json is `flyctl machines list --json`; version.json is the site's
// /api/version (empty when it didn't answer); secrets.json is
// `flyctl secrets list --json` (names and Fly's fingerprints, never the
// values); fly.toml is the one on main. WATCH_KEY, a secret only GitHub has,
// keys the fingerprints that are published, so they show a change without
// letting anyone guess a secret from them.
// Needs `gh` signed in, and `flyctl auth docker` so gh can read the image's manifest.

import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = 'jcolter11374/rsdp-poker-live';
const SIGNER = `${REPO}/.github/workflows/deploy.yml`;
/** The secrets the code reads. Any other one is an environment variable nobody can see the value of. */
const SECRETS = ['ADMIN_KEY', 'REPORT_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
/** Where fly.toml puts the data volume. */
const DATA = '/data';
const [machinesFile, versionFile, secretsFile, flyToml, dir] = process.argv.slice(2);
if (!machinesFile || !versionFile || !secretsFile || !flyToml || !dir) {
  console.error('usage: node scripts/transparency/deploys.mjs <machines.json> <version.json> <secrets.json> <fly.toml> <folder>');
  process.exit(3);
}

class Unreachable extends Error {}
const errText = (e) => String(e?.stderr || e?.message || e).trim();
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tries = async (fn, n = 3) => {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= n || /HTTP 404/.test(errText(e))) throw e;
      await new Promise((r) => setTimeout(r, Number(process.env.WATCH_RETRY_MS ?? 5_000) * i));
    }
  }
};
const sha = (v) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);
const keyed = (v) => (process.env.WATCH_KEY ? createHmac('sha256', process.env.WATCH_KEY).update(String(v)).digest('hex').slice(0, 16) : null);
const empty = (v) => v == null || (Array.isArray(v) ? v.length === 0 : typeof v === 'object' ? Object.keys(v).length === 0 : v === '');

/** fly.toml's [env]: the environment variables the public code sets. */
function tomlEnv(file) {
  const env = {};
  let inEnv = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith('[')) inEnv = t === '[env]';
    const m = inEnv && /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/.exec(t);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/**
 * Who built this image, by GitHub's signed record of it; null when GitHub has
 * no record that deploy.yml built it from main. Throws Unreachable when GitHub
 * couldn't be asked, which isn't a problem with the deploy.
 */
async function attestation(image, digest) {
  let listed;
  try {
    listed = await tries(() => JSON.parse(gh(['api', `repos/${REPO}/attestations/${digest}`])).attestations ?? []);
  } catch (e) {
    // GitHub answers 404 for an image it never signed.
    if (/HTTP 404/.test(errText(e))) return null;
    throw new Unreachable(`GitHub's list of signed images: ${errText(e)}`);
  }
  if (!listed.length) return null;
  try {
    const out = await tries(() => gh(['attestation', 'verify', `oci://${image}`, '--repo', REPO, '--signer-workflow', SIGNER, '--source-ref', 'refs/heads/main', '--format', 'json']));
    const cert = JSON.parse(out)[0]?.verificationResult?.signature?.certificate ?? {};
    return { commit: cert.sourceRepositoryDigest ?? null, ref: cert.sourceRepositoryRef ?? null, run: cert.runInvocationURI ?? null };
  } catch (e) {
    // Signed, but not by deploy.yml from main, or the signature doesn't hold.
    if (/verification failed|failed to verify|did not match|none of the|no matching|expected .* got/i.test(errText(e))) return null;
    // Anything else (the registry, Sigstore, a rate limit) is a hiccup: try again on the next run.
    throw new Unreachable(`checking GitHub's signature: ${errText(e)}`);
  }
}

/** Whether main still contains the commit, so the code it was built from is still the public code. */
function onMain(commit) {
  try {
    const status = JSON.parse(gh(['api', `repos/${REPO}/compare/${commit}...main`])).status;
    return status === 'ahead' || status === 'identical';
  } catch (e) {
    if (/HTTP 404/.test(errText(e))) return false;
    throw new Unreachable(`comparing with main: ${errText(e)}`);
  }
}

const starts = (m) =>
  (m.events ?? [])
    .filter((e) => ['start', 'launch', 'restart', 'exit'].includes(e.type))
    .map((e) => ({ type: e.type, status: e.status ?? null, at: e.timestamp ? new Date(Number(e.timestamp)).toISOString() : null }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
const lastStart = (m) => starts(m).filter((e) => e.type !== 'exit' && e.status !== 'failed').at(-1)?.at ?? null;

/** What in a machine's settings can change what runs, beyond the image. */
function settingsProblems(m, expectedEnv) {
  const out = [];
  const c = m.config ?? {};
  const init = c.init ?? {};
  for (const k of ['exec', 'entrypoint', 'cmd']) if (!empty(init[k])) out.push(`Machine ${m.id} has its start command replaced (init.${k}), so it may not run the code in its image.`);
  const envProblems = (env, where) => {
    for (const [k, v] of Object.entries(env ?? {})) {
      if (k.startsWith('FLY_') || k === 'PRIMARY_REGION') continue;
      if (!(k in expectedEnv)) out.push(`Machine ${m.id} sets ${k}${where}, which fly.toml on main doesn't.`);
      else if (expectedEnv[k] !== v) out.push(`Machine ${m.id} sets ${k} to "${v}"${where}, but fly.toml on main says "${expectedEnv[k]}".`);
    }
  };
  envProblems(c.env, '');
  for (const [i, p] of (c.processes ?? []).entries()) {
    for (const k of ['exec', 'entrypoint', 'cmd']) if (!empty(p?.[k])) out.push(`Machine ${m.id} has its start command replaced (processes[${i}].${k}).`);
    envProblems(p?.env, ` (processes[${i}])`);
    if (!empty(p?.secrets)) out.push(`Machine ${m.id} adds secrets to a process (processes[${i}]).`);
  }
  if (!empty(c.containers)) out.push(`Machine ${m.id} runs extra containers, which could be any code.`);
  if (!empty(c.files)) out.push(`Machine ${m.id} has files added on top of its image.`);
  for (const mount of c.mounts ?? []) if (mount?.path !== DATA) out.push(`Machine ${m.id} mounts a volume at ${mount?.path}, not ${DATA} as fly.toml says.`);
  return out;
}

try {
  const folder = path.join(dir, 'deploys');
  mkdirSync(folder, { recursive: true });
  const machines = JSON.parse(readFileSync(machinesFile, 'utf8'));
  let version = null;
  try {
    version = JSON.parse(readFileSync(versionFile, 'utf8'));
  } catch {}
  let secrets = [];
  try {
    secrets = JSON.parse(readFileSync(secretsFile, 'utf8'));
  } catch {}
  const expectedEnv = tomlEnv(flyToml);

  const problems = [];
  const seen = [];
  try {
    for (const m of machines) {
      const ref = m.image_ref ?? {};
      const digest = ref.digest ?? null;
      const image = digest ? `${ref.registry}/${ref.repository}@${digest}` : (m.config?.image ?? null);
      const signed = digest ? await attestation(image, digest) : null;
      if (m.state === 'started') {
        if (!signed) problems.push(`Machine ${m.id} runs ${image ?? 'an unknown image'}, which GitHub did not build and sign with deploy.yml from main.`);
        else if (signed.commit && !onMain(signed.commit)) problems.push(`Machine ${m.id} runs an image built from commit ${signed.commit}, which is no longer on main: main was rewritten after that build.`);
        problems.push(...settingsProblems(m, expectedEnv));
      }
      // A fingerprint, not the settings themselves (Fly's own bookkeeping left out): a change shows without publishing anything private.
      const settings = sha({ ...m.config, image: undefined, metadata: undefined });
      seen.push({ id: m.id, state: m.state, image, digest, lastStart: lastStart(m), starts: starts(m), settings, signed });
    }
  } catch (e) {
    if (!(e instanceof Unreachable)) throw e;
    console.error(`Couldn't ask GitHub: ${e.message}`);
    process.exit(2);
  }
  const secretList = secrets
    .map((x) => ({ name: String(x?.Name ?? x?.name ?? ''), fingerprint: keyed(x?.Digest ?? x?.digest ?? '') }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const x of secretList) if (!SECRETS.includes(x.name)) problems.push(`The app has a secret called ${x.name}, which the code doesn't use. Secrets become environment variables, and some (like NODE_OPTIONS) change what runs.`);
  const running = seen.filter((m) => m.state === 'started');
  if (running.length > 1) problems.push(`${running.length} machines are running; the site only ever runs one.`);
  if (!version?.commit) problems.push("The site didn't say which commit it runs (/api/version).");
  else if (running[0]?.signed?.commit && !running[0].signed.commit.startsWith(version.commit))
    problems.push(`The site says it runs commit ${version.commit}, but its image was built from ${running[0].signed.commit}.`);

  let before = null;
  try {
    before = JSON.parse(readFileSync(path.join(folder, 'current.json'), 'utf8'));
  } catch {}
  for (const m of seen) {
    const was = before?.machines?.find((b) => b.id === m.id);
    if (was && was.digest === m.digest && was.settings && was.settings !== m.settings) problems.push(`Machine ${m.id}'s settings changed without a new image.`);
  }
  const notes = [];
  if (before?.secrets && JSON.stringify(before.secrets) !== JSON.stringify(secretList)) notes.push("The app's secrets changed.");

  const now = new Date().toISOString();
  const current = { checked: now, machines: seen, secrets: secretList, site: version, problems, ...(notes.length ? { notes } : {}) };
  const key = (c) => JSON.stringify([c.machines.map((m) => [m.id, m.state, m.digest, m.starts, m.settings]), c.secrets, c.site?.commit, c.site?.startedAt, c.problems]);
  if (!before || key(before) !== key(current)) appendFileSync(path.join(folder, 'log.jsonl'), `${JSON.stringify(current)}\n`);
  writeFileSync(path.join(folder, 'current.json'), `${JSON.stringify(current, null, 2)}\n`);

  if (problems.length) {
    writeFileSync(path.join(folder, 'PROBLEM.md'), `# The deploy watcher found a problem\n\nChecked ${now}.\n\n${problems.map((p) => `- ${p}`).join('\n')}\n`);
    console.error(problems.join('\n'));
    process.exit(1);
  }
  rmSync(path.join(folder, 'PROBLEM.md'), { force: true });
  console.log(running.map((m) => `${m.id}: ${m.digest} from ${m.signed?.commit}, started ${m.lastStart}`).join('\n') || 'no machine running');
} catch (e) {
  console.error('The deploy check went wrong:', e);
  process.exit(3);
}

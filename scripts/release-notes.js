#!/usr/bin/env node
// Release notes helper. Solstice's changelogs are GitHub *release notes*, not
// CHANGELOG.md (that file tracks Horizon versions and is inherited), so this
// script owns the mechanical half of writing them.
//
//   node scripts/release-notes.js draft [version]
//     Scaffolds release-notes/v<version>.md: the "Built on Horizon X.Y.Z" line
//     read from chat/version.ts, and one TODO bullet per commit since the
//     previous Solstice release, for you to rewrite in user-facing words.
//
//   node scripts/release-notes.js publish [version] [--dry-run]
//     Checks the file is finished, sets it as the body of the v<version>
//     GitHub release, and writes the Discord post next to it. --dry-run does
//     everything except touch GitHub.
//
// Version defaults to the root package.json in both cases.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const NOTES_DIR = 'release-notes';
// Solstice's own tags are CalVer; the repo also carries Horizon's vX.Y.Z tags.
const CALVER_TAG = /^v\d{4}\.\d{1,2}\.\d+$/;
const DISCORD_LIMIT = 2000;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function rootVersion() {
  return JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
}

function horizonBase() {
  const src = fs.readFileSync('chat/version.ts', 'utf8');
  const match = /HORIZON_BASE_VERSION\s*=\s*'([^']+)'/.exec(src);
  if (!match) fail('could not read HORIZON_BASE_VERSION from chat/version.ts');
  return match[1];
}

// The newest stable Solstice tag before this release. Pre-release tags are
// skipped: a stable's notes cover everything since the last stable, because
// that is all its users saw.
function previousStable(version) {
  const tags = git('tag', '--sort=-v:refname')
    .split('\n')
    .filter(t => CALVER_TAG.test(t) && t !== `v${version}`);
  if (!tags.length) fail('no previous Solstice release tag found');
  return tags[0];
}

function subjectsSince(tag) {
  // First parent only: one line per thing that landed, not per commit inside a
  // branch. Release chores are noise in notes aimed at users.
  return git('log', '--first-parent', '--format=%s', `${tag}..HEAD`)
    .split('\n')
    .filter(Boolean)
    .filter(s => !/^chore: (release|bump)/.test(s))
    .reverse();
}

// PRs merged in the range that someone else opened, so their work is credited
// rather than quietly shipped. Best effort: it needs gh and the network, and a
// release can be drafted without either.
function externalCredits(tag) {
  const mentioned = new Set(
    [...git('log', '--format=%s', `${tag}..HEAD`).matchAll(/#(\d+)/g)].map(
      m => m[1]
    )
  );
  if (!mentioned.size) return [];
  try {
    // Issue numbers appear in subjects too; intersecting with the merged PR
    // list drops them.
    const me = execFileSync('gh', ['api', 'user', '-q', '.login'], {
      encoding: 'utf8'
    }).trim();
    const prs = JSON.parse(
      execFileSync(
        'gh',
        [
          'pr',
          'list',
          '--state',
          'merged',
          '--limit',
          '100',
          '--json',
          'number,author,title'
        ],
        { encoding: 'utf8' }
      )
    );
    return prs
      .filter(pr => mentioned.has(String(pr.number)) && pr.author.login !== me)
      .map(pr => ({
        number: pr.number,
        author: pr.author.login,
        title: pr.title
      }));
  } catch {
    console.log('note: could not reach gh to look up contributors');
    return [];
  }
}

function notesPath(version) {
  return path.join(NOTES_DIR, `v${version}.md`);
}

function draft(version) {
  const file = notesPath(version);
  if (fs.existsSync(file)) fail(`${file} already exists; edit it or delete it`);
  const prev = previousStable(version);
  const bullets = subjectsSince(prev)
    .map(s => `- **TODO.** ${s}\n`)
    .join('');
  const credits = externalCredits(prev);
  const thanks = credits.length
    ? '\n## Thanks\n\n' +
      credits
        .map(
          c =>
            `- **@${c.author}** TODO for what, from "${c.title}" (#${c.number}).\n`
        )
        .join('')
    : '';
  const body =
    `Built on Horizon ${horizonBase()}.\n\n` +
    `TODO one line saying what this release is about.\n\n` +
    `## Changes since ${prev}\n\n` +
    bullets +
    thanks;
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.writeFileSync(file, body);
  console.log(
    `wrote ${file} (${bullets.split('\n').length - 1} commits since ${prev})`
  );
  console.log(
    'Rewrite every bullet for users, bold lead-in first, then: pnpm release:notes'
  );
  if (credits.length)
    console.log(
      `${credits.length} PR(s) from other people are listed under Thanks; say what they did.`
    );
}

// The Discord post is a near-mechanical transform of the release notes: bold
// title instead of a header, build line and summary merged into one paragraph,
// a plain section line, the same bullets, and a bare /releases/latest link so
// Discord renders its embed card.
function discordPost(version, body) {
  const [buildLine, summary, ...rest] = body.split('\n\n');
  const heading = rest.findIndex(block => block.startsWith('## Changes since'));
  if (heading === -1) fail('notes have no "## Changes since" section');
  const prev = rest[heading].replace('## Changes since v', '').trim();
  // Any further "## Section" heading becomes a bold line: the post leads with a
  // bold title rather than headers, so headers inside it look out of place.
  const bullets = rest
    .slice(heading + 1)
    .join('\n\n')
    .replace(/^## (.+)$/gm, '**$1**');
  return (
    `**Solstice v${version} is out**\n\n` +
    `${buildLine} ${summary}\n\n` +
    `What changed since ${prev}:\n` +
    `${bullets.trim()}\n\n` +
    `https://github.com/Fchat-Horizon/Solstice/releases/latest\n`
  );
}

function publish(version, dryRun) {
  const file = notesPath(version);
  if (!fs.existsSync(file))
    fail(`${file} does not exist; run the draft step first`);
  const body = fs.readFileSync(file, 'utf8');
  if (body.includes('TODO')) fail(`${file} still has TODO markers in it`);
  // House rule, and easier to catch here than in review.
  if (body.includes('—')) fail(`${file} contains an em dash`);

  // The tag is pushed to both remotes and each one's CI builds its own draft
  // release, so both need the notes. Testers install from the fork.
  const repos = ['origin', 'fork']
    .map(remote => {
      let url;
      try {
        url = git('remote', 'get-url', remote);
      } catch {
        return null;
      }
      const match = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url);
      return match && match[1];
    })
    .filter(Boolean);
  if (!repos.length) fail('no GitHub origin or fork remote to publish to');

  // Written before touching GitHub, so a failed upload still leaves you the
  // post to look over.
  const discordFile = path.join(NOTES_DIR, `discord-v${version}.md`);
  if (fs.existsSync(discordFile)) {
    // Long releases have to be trimmed by hand to fit Discord; never clobber
    // that work on a re-run.
    console.log(`kept the existing ${discordFile}`);
  } else {
    const post = discordPost(version, body);
    fs.writeFileSync(discordFile, post);
    console.log(`wrote ${discordFile} (${post.length} characters)`);
    if (post.length > DISCORD_LIMIT)
      console.log(
        `NOTE: over Discord's ${DISCORD_LIMIT} character limit, trim it before posting`
      );
  }

  if (dryRun) {
    for (const repo of repos)
      console.log(`would set the body of ${repo} v${version} from ${file}`);
    return;
  }
  const failed = [];
  for (const repo of repos) {
    try {
      execFileSync(
        'gh',
        ['release', 'edit', `v${version}`, '-R', repo, '--notes-file', file],
        { stdio: 'inherit' }
      );
      console.log(`set the body of ${repo} v${version} from ${file}`);
    } catch {
      // Most likely that remote's build has not created the release yet.
      failed.push(repo);
    }
  }
  for (const repo of failed)
    console.log(
      `COULD NOT set the body of ${repo} v${version}; has its build finished?`
    );
  console.log(
    'The releases are still drafts. Publish them when the assets look right:'
  );
  for (const repo of repos)
    console.log(`  gh release edit v${version} -R ${repo} --draft=false`);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [mode, version = rootVersion()] = args.filter(a => a !== '--dry-run');
if (mode === 'draft') draft(version);
else if (mode === 'publish') publish(version, dryRun);
else fail('usage: release-notes.js <draft|publish> [version] [--dry-run]');

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = (await readFile(new URL("../.github/workflows/console-release.yml", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const publishJob = workflow.split("\n  publish:\n")[1]?.split("\n  recover-publish:\n")[0];
assert.ok(publishJob, "The standard release publisher must be present");
const publishScript = publishJob.split("        run: |\n")[1].replace(/^ {10}/gm, "");
const bash = process.env.PI_TEST_BASH || "bash";
const probe = spawnSync(bash, ["-c", "command -v jq >/dev/null"], { encoding: "utf8" });
const options = { skip: process.platform === "win32" && probe.status !== 0 ? "Requires Bash and jq" : false };
const tag = "v0.0.1";
const source = "a".repeat(40);
const title = `Pi Console ${tag}`;
const marker = `<!-- pi-console-release-workflow-owned:v1 tag=${tag} source=${source} -->`;
const owned = {
	id: 42,
	draft: true,
	prerelease: false,
	tag_name: tag,
	name: title,
	author: { login: "github-actions[bot]" },
	body: marker,
	assets: [],
};

// Execute the publisher's actual Bash and jq guards; only network calls and
// delays are replaced. No credentials, GitHub mutations, or model calls occur.
const functions = [
	"load_release_inventory",
	"classify_release_inventory",
	"assert_recoverable_inventory",
	"assert_exact_tag_ref",
	"assert_draft_tag_binding",
	"assert_owned_draft_json",
	"load_active_draft",
].map((name) => {
	const body = publishScript.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"))?.[0];
	assert.ok(body, `Missing publisher function: ${name}`);
	return body;
}).join("\n");

const mocks = String.raw`
next_count() {
  local path="$FIXTURE_DIRECTORY/$1-count"
  local count
  count="$(< "$path")"
  printf '%s' "$((count + 1))" > "$path"
  printf '%s' "$count"
}
gh() {
  local count
  case "$*" in
    "api --paginate repos/fixture/pi/releases?per_page=100")
      count="$(next_count inventory)"
      if jq -e '.inventoryError == true' "$FIXTURE_FILE" >/dev/null; then return 1; fi
      jq -c --argjson index "$count" '.inventories[([$index, (.inventories | length) - 1] | min)]' "$FIXTURE_FILE"
      ;;
    "api repos/fixture/pi/git/ref/tags/v0.0.1")
      count="$(next_count tag)"
      jq -c --argjson index "$count" --arg source "$SOURCE_SHA" '
        {object: {type: (.tagType // "commit"), sha: (.tagShas[$index] // $source)}}
      ' "$FIXTURE_FILE"
      ;;
    "api repos/fixture/pi/releases/42")
      next_count direct >/dev/null
      if jq -e '.directError == true' "$FIXTURE_FILE" >/dev/null; then return 1; fi
      jq -c '.directRelease' "$FIXTURE_FILE"
      ;;
    *) echo "Unexpected gh invocation: $*" >&2; return 1 ;;
  esac
}
curl() {
  next_count synthetic >/dev/null
  jq -r '.syntheticStatus // "404"' "$FIXTURE_FILE"
}
sleep() {
  [[ "$1" == "2" ]] || return 1
  next_count sleep >/dev/null
}
`;

async function runDraftCheck(fixture = {}, waitForCreated = true) {
	assert.equal(probe.status, 0, `Bash and jq must be available: ${probe.stderr || probe.error || ""}`);
	const root = await mkdtemp(join(tmpdir(), "pi-console-release-"));
	try {
		const fixtureFile = join(root, "fixture.json");
		const scriptFile = join(root, "check.sh");
		await writeFile(fixtureFile, JSON.stringify({ inventories: [[owned]], directRelease: owned, ...fixture }));
		for (const name of ["inventory", "tag", "direct", "synthetic", "sleep"]) {
			await writeFile(join(root, `${name}-count`), "0");
		}
		await writeFile(scriptFile, `set -euo pipefail\n${mocks}\n${functions}\nload_active_draft ${waitForCreated ? "--wait-for-created-draft" : ""}\n`);
		const result = spawnSync(bash, [scriptFile.replaceAll("\\", "/")], {
			encoding: "utf8",
			timeout: 30_000,
			env: {
				...process.env,
				FIXTURE_DIRECTORY: root.replaceAll("\\", "/"),
				FIXTURE_FILE: fixtureFile.replaceAll("\\", "/"),
				TMPDIR: root.replaceAll("\\", "/"),
				GITHUB_REPOSITORY: "fixture/pi",
				GITHUB_API_URL: "https://api.invalid",
				GH_TOKEN: "fixture-unused-token",
				RELEASE_TAG: tag,
				SOURCE_SHA: source,
				release_title: title,
				release_marker: marker,
				asset_marker: `pi-console-release-workflow-owned:v1:${tag}:${source}`,
				active_release_id: "42",
			},
		});
		const counts = {};
		for (const name of ["inventory", "tag", "direct", "synthetic", "sleep"]) {
			counts[name] = Number(await readFile(join(root, `${name}-count`), "utf8"));
		}
		return { ...result, counts };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("the standard publisher remains valid Bash", options, () => {
	const result = spawnSync(bash, ["-n"], { input: publishScript, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(publishScript.match(/load_active_draft --wait-for-created-draft/g)?.length, 1);
	assert.match(publishScript, /assert_owned_draft_json "\$\(< "\$\{create_response\}"\)"[\s\S]*load_active_draft --wait-for-created-draft/);
});

test("a just-created draft becomes visible after empty inventory responses", options, async () => {
	const result = await runDraftCheck({ inventories: [[], [], [owned]] });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), owned);
	assert.deepEqual(result.counts, { inventory: 3, tag: 3, direct: 1, synthetic: 0, sleep: 2 });
});

test("an immediately visible draft needs no delay", options, async () => {
	const result = await runDraftCheck();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.counts.sleep, 0);
	assert.equal(result.counts.inventory, 1);
});

test("empty inventory retries stop at six checks without returning a draft", options, async () => {
	const result = await runDraftCheck({ inventories: [[]] });
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.deepEqual(result.counts, { inventory: 6, tag: 6, direct: 0, synthetic: 0, sleep: 5 });
});

test("ordinary draft revalidation does not retry a missing release", options, async () => {
	const result = await runDraftCheck({ inventories: [[]] }, false);
	assert.equal(result.status, 1);
	assert.equal(result.counts.inventory, 1);
	assert.equal(result.counts.sleep, 0);
});

for (const [name, inventory] of [
	["different owned release ID", [{ ...owned, id: 43 }]],
	["duplicate owned drafts", [owned, { ...owned, id: 43 }]],
	["conflicting author", [{ ...owned, author: { login: "someone-else" } }]],
	["conflicting marker", [{ ...owned, body: `${marker}\n${marker}` }]],
	["public release", [{ ...owned, draft: false }]],
	["unowned tagged release", [{ ...owned, name: "other", body: "unowned" }]],
]) {
	test(`visibility wait immediately rejects ${name}`, options, async () => {
		const result = await runDraftCheck({ inventories: [inventory, [owned]] });
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.equal(result.counts.inventory, 1);
		assert.equal(result.counts.direct, 0);
		assert.equal(result.counts.sleep, 0);
	});
}

test("conflicts appearing during the visibility wait stop further retries", options, async () => {
	const result = await runDraftCheck({ inventories: [[], [{ ...owned, draft: false }], [owned]] });
	assert.equal(result.status, 1);
	assert.equal(result.counts.inventory, 2);
	assert.equal(result.counts.sleep, 1);
});

test("an exact tag change during the visibility wait fails before the next inventory read", options, async () => {
	const result = await runDraftCheck({ inventories: [[], [owned]], tagShas: [source, "b".repeat(40)] });
	assert.equal(result.status, 1);
	assert.equal(result.counts.tag, 2);
	assert.equal(result.counts.inventory, 1);
	assert.equal(result.counts.sleep, 1);
});

test("inventory lookup errors fail immediately", options, async () => {
	const result = await runDraftCheck({ inventoryError: true });
	assert.equal(result.status, 1);
	assert.equal(result.counts.inventory, 1);
	assert.equal(result.counts.sleep, 0);
});

for (const [name, directRelease] of [
	["numeric ID", { ...owned, id: 43 }],
	["author", { ...owned, author: { login: "someone-else" } }],
	["ownership marker", { ...owned, body: "missing" }],
	["draft state", { ...owned, draft: false }],
	["prerelease state", { ...owned, prerelease: true }],
	["tag", { ...owned, tag_name: "v9.9.9" }],
]) {
	test(`visible inventory still requires exact ${name} on numeric-ID reload`, options, async () => {
		const result = await runDraftCheck({ inventories: [[], [owned]], directRelease });
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.equal(result.counts.direct, 1);
		assert.equal(result.counts.sleep, 1);
	});
}

test("synthetic draft tags still require proof that their Git ref is absent", options, async () => {
	const synthetic = { ...owned, tag_name: `untagged-${"c".repeat(20)}` };
	const allowed = await runDraftCheck({ inventories: [[], [synthetic]], directRelease: synthetic });
	assert.equal(allowed.status, 0, allowed.stderr);
	assert.equal(allowed.counts.synthetic, 1);
	const denied = await runDraftCheck({ inventories: [[], [synthetic]], directRelease: synthetic, syntheticStatus: "200" });
	assert.equal(denied.status, 1);
	assert.equal(denied.stdout, "");
	assert.equal(denied.counts.synthetic, 1);
});

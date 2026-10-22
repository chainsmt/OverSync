import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const releasePath = resolve(repoRoot, ".github/workflows/release.yml");

function parseScalar(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) ||
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Indentation parser for the release workflow. Covers mappings, lists,
 * block scalars, and comments — enough to read jobs and steps.
 */
function parseWorkflow(source) {
  const lines = source.split(/\n/);
  const root = {};
  const stack = [{ indent: -1, container: root, kind: "map" }];

  function nextMeaningful(from) {
    for (let i = from; i < lines.length; i++) {
      const text = lines[i].trim();
      if (!text || text.startsWith("#")) continue;
      return { index: i, indent: lines[i].search(/\S/), text };
    }
    return null;
  }

  function assign(obj, key, valuePart, keyIndent, lineIndex) {
    if (valuePart === "|" || valuePart === ">") {
      const block = [];
      let blockIndent = null;
      let i = lineIndex + 1;
      for (; i < lines.length; i++) {
        const raw = lines[i];
        if (!raw.trim()) {
          block.push("");
          continue;
        }
        const indent = raw.search(/\S/);
        if (blockIndent === null) {
          if (indent <= keyIndent) break;
          blockIndent = indent;
        }
        if (indent < blockIndent) break;
        block.push(raw.slice(blockIndent));
      }
      while (block.length > 0 && block[block.length - 1] === "") block.pop();
      obj[key] = block.join("\n");
      return i - 1;
    }

    if (valuePart !== "") {
      obj[key] = parseScalar(valuePart);
      return lineIndex;
    }

    const next = nextMeaningful(lineIndex + 1);
    if (!next || next.indent <= keyIndent) {
      obj[key] = null;
      return lineIndex;
    }

    if (next.text.startsWith("- ")) {
      const seq = [];
      obj[key] = seq;
      stack.push({ indent: keyIndent, container: seq, kind: "seq" });
    } else {
      const map = {};
      obj[key] = map;
      stack.push({ indent: keyIndent, container: map, kind: "map" });
    }
    return lineIndex;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const text = raw.trim();
    if (!text || text.startsWith("#")) continue;
    const indent = raw.search(/\S/);

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];

    if (text.startsWith("- ")) {
      if (parent.kind !== "seq") {
        throw new Error(`list item outside a sequence at line ${i + 1}`);
      }
      const rest = text.slice(2).trim();
      const colon = rest.indexOf(":");
      if (colon === -1) {
        parent.container.push(parseScalar(rest));
        continue;
      }
      const item = {};
      parent.container.push(item);
      stack.push({ indent, container: item, kind: "map" });
      const key = rest.slice(0, colon).trim();
      const valuePart = rest.slice(colon + 1).trim();
      i = assign(item, key, valuePart, indent, i);
      continue;
    }

    if (parent.kind !== "map") {
      throw new Error(`expected a mapping at line ${i + 1}`);
    }
    const colon = text.indexOf(":");
    if (colon === -1) {
      throw new Error(`expected a key at line ${i + 1}`);
    }
    const key = text.slice(0, colon).trim();
    const valuePart = text.slice(colon + 1).trim();
    i = assign(parent.container, key, valuePart, indent, i);
  }

  return root;
}

function stepUses(step) {
  return typeof step.uses === "string" ? step.uses : "";
}

describe("resolver release SBOM", () => {
  const source = readFileSync(releasePath, "utf8");
  const workflow = parseWorkflow(source);
  const job = workflow.jobs?.["resolver-docker"];

  it("parses the resolver release job", () => {
    assert.equal(workflow.name, "release");
    assert.ok(job, "resolver-docker job is missing");
    assert.ok(Array.isArray(job.steps), "resolver-docker steps are missing");
  });

  it("generates an SBOM for the resolver image", () => {
    const build = job.steps.find((step) =>
      stepUses(step).startsWith("docker/build-push-action@")
    );
    assert.ok(build, "resolver image build step is missing");
    assert.equal(build.with?.context, "./resolver");
    assert.equal(build.with?.file, "./resolver/Dockerfile");
    assert.equal(build.with?.sbom, true);

    const exported = job.steps.find(
      (step) =>
        typeof step.run === "string" &&
        step.run.includes("imagetools inspect") &&
        step.run.includes("oversync-resolver") &&
        step.run.includes(".SBOM")
    );
    assert.ok(exported, "resolver image SBOM is not exported from the built image");
    assert.match(exported.run, /resolver-image-sbom\.json/);
  });

  it("uploads the SBOM artifact with a short retention period", () => {
    const upload = job.steps.find((step) =>
      stepUses(step).startsWith("actions/upload-artifact@")
    );
    assert.ok(upload, "SBOM upload step is missing");
    assert.equal(upload.with?.name, "resolver-image-sbom");
    assert.equal(upload.with?.path, "resolver-image-sbom.json");
    assert.equal(typeof upload.with?.["retention-days"], "number");
    assert.ok(upload.with["retention-days"] >= 1);
    assert.ok(upload.with["retention-days"] <= 30);
    assert.match(
      source,
      /#.*14 days.*\n\s*retention-days:\s*14/
    );
  });
});

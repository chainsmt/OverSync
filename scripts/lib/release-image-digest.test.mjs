import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const workflowPath = resolve(
  fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url)),
);

/**
 * Collects each step under the first `steps:` block.
 * Comment-only lines are kept out of the step body so documentation
 * cannot satisfy the digest and tag assertions.
 */
function parseSteps(yaml) {
  const lines = yaml.split(/\r?\n/);
  const steps = [];
  let inSteps = false;
  let stepsIndent = 0;
  let current = null;

  for (const line of lines) {
    if (!inSteps) {
      const header = line.match(/^(\s*)steps:\s*$/);
      if (header) {
        inSteps = true;
        stepsIndent = header[1].length;
      }
      continue;
    }

    if (line.trim() === "") {
      if (current) current.lines.push(line);
      continue;
    }

    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= stepsIndent) break;

    const stepStart = line.match(/^(\s*)-\s+(.*)$/);
    if (stepStart && stepStart[1].length === stepsIndent + 2) {
      current = { lines: [line] };
      steps.push(current);
      continue;
    }

    if (current && !line.trim().startsWith("#")) current.lines.push(line);
  }

  return steps;
}

function stepText(step) {
  return step.lines.join("\n");
}

describe("release workflow job summary", () => {
  it("records the pushed image digest and tag list after a successful push", () => {
    const yaml = readFileSync(workflowPath, "utf8");
    const steps = parseSteps(yaml);

    const push = steps.find((step) =>
      stepText(step).includes("docker/build-push-action@"),
    );
    assert.ok(push, "build-push step is missing");

    const idLine = push.lines.find((line) => /^\s*id:\s*\S+/.test(line));
    assert.ok(idLine, "build-push step must expose outputs.digest via an id");
    const pushId = idLine.match(/id:\s*(\S+)/)[1];

    const summary = steps.find((step) => stepText(step).includes("GITHUB_STEP_SUMMARY"));
    assert.ok(summary, "job summary step is missing");

    const summaryText = stepText(summary);
    assert.match(
      summaryText,
      new RegExp(`steps\\.${pushId}\\.outputs\\.digest`),
      "summary step must include the build-push digest output",
    );
    assert.match(
      summaryText,
      /steps\.meta\.outputs\.tags/,
      "summary step must include the metadata-action tag list",
    );
    assert.ok(
      steps.indexOf(summary) > steps.indexOf(push),
      "summary step must run after the push",
    );
  });
});

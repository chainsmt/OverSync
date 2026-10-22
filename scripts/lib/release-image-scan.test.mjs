import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const releaseWorkflowPath = resolve(repoRoot, ".github/workflows/release.yml");

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseKeyValue(text) {
  const match = text.match(/^([^:]+):\s*(.*)$/);
  if (!match) return null;
  return { key: match[1].trim(), value: unquote(match[2]) };
}

/** Ordered job steps from a GitHub Actions workflow file. */
export function parseWorkflowSteps(source) {
  const lines = source.split(/\r?\n/);
  const stepsHeader = lines.findIndex((line) => /^(\s*)steps:\s*$/.test(line));
  if (stepsHeader < 0) {
    throw new Error("release workflow has no steps block");
  }

  const stepsIndent = lines[stepsHeader].match(/^(\s*)/)[1].length;
  const steps = [];
  let current = null;
  let withIndent = null;

  for (let index = stepsHeader + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= stepsIndent) break;

    const stepMatch = line.match(/^\s*-\s+(.*)$/);
    if (stepMatch && indent === stepsIndent + 2) {
      current = { name: "", uses: "", run: "", with: {} };
      steps.push(current);
      withIndent = null;
      const inline = parseKeyValue(stepMatch[1]);
      if (inline?.key === "name") current.name = inline.value;
      if (inline?.key === "uses") current.uses = inline.value;
      if (inline?.key === "run") current.run = inline.value;
      continue;
    }

    if (!current) continue;

    const field = parseKeyValue(line.trim());
    if (!field) continue;

    if (indent === stepsIndent + 4 && field.key === "with") {
      withIndent = indent;
      continue;
    }

    if (withIndent !== null && indent > withIndent) {
      current.with[field.key] = field.value;
      continue;
    }

    if (indent === stepsIndent + 4) {
      withIndent = null;
      if (field.key === "name") current.name = field.value;
      if (field.key === "uses") current.uses = field.value;
      if (field.key === "run") current.run = field.value;
    }
  }

  return steps;
}

function isEnabled(value) {
  return String(value).trim().toLowerCase() === "true";
}

function isPushStep(step) {
  return step.uses.startsWith("docker/build-push-action") && isEnabled(step.with.push);
}

function isLocalImageBuild(step) {
  return (
    step.uses.startsWith("docker/build-push-action") &&
    isEnabled(step.with.load) &&
    !isEnabled(step.with.push) &&
    step.with.tags === "oversync-resolver:scan"
  );
}

function failsOnHighOrCritical(step) {
  const uses = step.uses.toLowerCase();
  if (uses.startsWith("aquasecurity/trivy-action")) {
    const severities = String(step.with.severity || "")
      .toUpperCase()
      .split(/[,\s]+/)
      .filter(Boolean);
    const exitCode = Number(step.with["exit-code"]);
    return severities.includes("HIGH") && severities.includes("CRITICAL") && exitCode > 0;
  }

  if (uses.startsWith("anchore/scan-action")) {
    const cutoff = String(step.with["severity-cutoff"] || "").toLowerCase();
    return isEnabled(step.with["fail-build"]) && (cutoff === "high" || cutoff === "critical");
  }

  return false;
}

describe("release.yml resolver image scan", () => {
  const steps = parseWorkflowSteps(readFileSync(releaseWorkflowPath, "utf8"));
  const localBuildIndex = steps.findIndex(isLocalImageBuild);
  const scanIndex = steps.findIndex(failsOnHighOrCritical);
  const pushIndex = steps.findIndex(isPushStep);

  it("parses a scan step that fails on high and critical findings", () => {
    assert.ok(scanIndex >= 0, "expected a Trivy or Anchore scan that fails on HIGH/CRITICAL");
    const scan = steps[scanIndex];
    assert.match(scan.uses, /^(aquasecurity\/trivy-action|anchore\/scan-action)@/);
    assert.equal(scan.with["image-ref"], "oversync-resolver:scan");
  });

  it("builds the resolver image locally and scans it before push", () => {
    assert.ok(localBuildIndex >= 0, "expected a local load of oversync-resolver:scan");
    assert.ok(pushIndex >= 0, "expected the registry push step to remain");
    assert.ok(localBuildIndex < scanIndex, "local image build must run before the scan");
    assert.ok(scanIndex < pushIndex, "scan must run before docker push");
  });
});

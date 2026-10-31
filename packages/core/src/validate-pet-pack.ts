import Ajv, { type ErrorObject } from "ajv";

import { assetManifestSchema, petPackSchema } from "./pet-pack-schema.js";
import type { AssetManifest, PetPack } from "./pet-pack.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { success: true; value: T }
  | { success: false; errors: ValidationIssue[] };

export interface ValidatedPetPack {
  pack: PetPack;
  manifest: AssetManifest;
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validatePackSchema = ajv.compile<PetPack>(petPackSchema);
const validateManifestSchema = ajv.compile<AssetManifest>(assetManifestSchema);

export function validatePetPack(
  pack: unknown,
  manifest: unknown,
): ValidationResult<ValidatedPetPack> {
  if (!validatePackSchema(pack)) {
    return { success: false, errors: validationIssues("pack", validatePackSchema.errors) };
  }
  if (!validateManifestSchema(manifest)) {
    return {
      success: false,
      errors: validationIssues("manifest", validateManifestSchema.errors),
    };
  }
  const semanticIssues = [
    ...validatePackSemantics(pack),
    ...validateManifestSemantics(pack, manifest),
  ];
  if (semanticIssues.length > 0) {
    return { success: false, errors: semanticIssues };
  }
  return { success: true, value: { pack, manifest } };
}

function validatePackSemantics(pack: PetPack): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [state, animation] of Object.entries(pack.states)) {
    if (!animation) {
      continue;
    }
    const stateClipIds = new Set<string>();
    animation.clips.forEach((clipId, index) => {
      if (!pack.clips[clipId]) {
        issues.push({
          path: `pack/states/${state}/clips/${index}`,
          message: "Referenced clip does not exist",
        });
      }
      if (stateClipIds.has(clipId)) {
        issues.push({
          path: `pack/states/${state}/clips/${index}`,
          message: "Clip references must be unique",
        });
      }
      stateClipIds.add(clipId);
    });
    if (animation.clips.length !== animation.weights.length) {
      issues.push({
        path: `pack/states/${state}/weights`,
        message: "Weights must match the clip count",
      });
    }
    if (animation.weights.reduce((sum, weight) => sum + weight, 0) <= 0) {
      issues.push({
        path: `pack/states/${state}/weights`,
        message: "Weights must have a positive sum",
      });
    }
  }
  for (const [clipId, clip] of Object.entries(pack.clips)) {
    clip.sources.forEach((source, index) => {
      if (!isSafeAssetPath(source.path)) {
        issues.push({
          path: `pack/clips/${clipId}/sources/${index}/path`,
          message: "Asset path must be a safe relative path",
        });
      }
    });
  }
  const actionIds = new Set<string>();
  pack.actions.forEach((action, actionIndex) => {
    if (actionIds.has(action.id)) {
      issues.push({
        path: `pack/actions/${actionIndex}/id`,
        message: "Action IDs must be unique",
      });
    }
    actionIds.add(action.id);
    const actionClipIds = new Set<string>();
    action.clips.forEach((clipId, clipIndex) => {
      if (!pack.clips[clipId]) {
        issues.push({
          path: `pack/actions/${actionIndex}/clips/${clipIndex}`,
          message: "Referenced clip does not exist",
        });
      }
      if (actionClipIds.has(clipId)) {
        issues.push({
          path: `pack/actions/${actionIndex}/clips/${clipIndex}`,
          message: "Clip references must be unique",
        });
      }
      actionClipIds.add(clipId);
    });
  });
  return issues;
}

function validateManifestSemantics(
  pack: PetPack,
  manifest: AssetManifest,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sourcePaths = new Set(
    Object.values(pack.clips).flatMap((clip) => clip.sources.map((source) => source.path)),
  );
  const entryPaths = new Set<string>();
  manifest.files.forEach((entry, index) => {
    if (entryPaths.has(entry.path)) {
      issues.push({
        path: `manifest/files/${index}/path`,
        message: "Asset paths must be unique",
      });
    }
    entryPaths.add(entry.path);
    if (!isSafeAssetPath(entry.path)) {
      issues.push({
        path: `manifest/files/${index}/path`,
        message: "Asset path must be a safe relative path",
      });
    }
    if (!sourcePaths.has(entry.path)) {
      issues.push({
        path: `manifest/files/${index}/path`,
        message: "Manifest entry is not referenced by a clip",
      });
    }
  });
  for (const path of sourcePaths) {
    if (!entryPaths.has(path)) {
      issues.push({
        path: "manifest/files",
        message: `Missing manifest entry for ${path}`,
      });
    }
  }
  const totalBytes = manifest.files.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes > 256 * 1024 * 1024) {
    issues.push({
      path: "manifest/files",
      message: "Asset manifest exceeds the 256 MiB total size limit",
    });
  }
  return issues;
}

function isSafeAssetPath(path: string): boolean {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path === "pet-pack.json" ||
    path === "assets.manifest.json"
  ) {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function validationIssues(
  root: string,
  errors: ErrorObject[] | null | undefined,
): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: `${root}${error.instancePath || "/"}`,
    message: error.message ?? "Invalid value",
  }));
}

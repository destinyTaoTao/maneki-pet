const idPattern = "^[a-z0-9][a-z0-9-]{0,63}$";
const clipIdPattern = "^[a-z][a-z0-9-]{0,63}$";

const stateAnimationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["clips", "weights"],
  properties: {
    clips: {
      type: "array",
      minItems: 1,
      items: { type: "string", pattern: clipIdPattern },
    },
    weights: {
      type: "array",
      minItems: 1,
      items: { type: "number", minimum: 0 },
    },
  },
};

const videoAlphaSourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["renderer", "path", "mimeType"],
  properties: {
    renderer: { const: "video-alpha" },
    path: { type: "string", minLength: 1, maxLength: 240 },
    mimeType: { enum: ["video/webm", "video/quicktime"] },
  },
};

const spritesheetSourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "renderer",
    "path",
    "mimeType",
    "frameWidth",
    "frameHeight",
    "frameCount",
    "framesPerSecond",
  ],
  properties: {
    renderer: { const: "spritesheet" },
    path: { type: "string", minLength: 1, maxLength: 240 },
    mimeType: { enum: ["image/png", "image/webp"] },
    frameWidth: { type: "integer", minimum: 1 },
    frameHeight: { type: "integer", minimum: 1 },
    frameCount: { type: "integer", minimum: 1 },
    framesPerSecond: { type: "number", exclusiveMinimum: 0 },
  },
};

export const petPackSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "id",
    "name",
    "version",
    "permissions",
    "clips",
    "states",
    "actions",
  ],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", pattern: idPattern },
    name: { type: "string", minLength: 1, maxLength: 80 },
    version: {
      type: "string",
      pattern: "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$",
    },
    permissions: { type: "array", maxItems: 0 },
    clips: {
      type: "object",
      minProperties: 1,
      propertyNames: { pattern: clipIdPattern },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["sources"],
        properties: {
          sources: {
            type: "array",
            minItems: 1,
            items: { oneOf: [videoAlphaSourceSchema, spritesheetSourceSchema] },
          },
        },
      },
    },
    states: {
      type: "object",
      additionalProperties: false,
      required: ["idle"],
      properties: {
        idle: stateAnimationSchema,
        thinking: stateAnimationSchema,
        working: stateAnimationSchema,
        waiting_input: stateAnimationSchema,
        celebrating: stateAnimationSchema,
        error: stateAnimationSchema,
        sleeping: stateAnimationSchema,
      },
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "clips", "priority", "interruptible"],
        properties: {
          id: { type: "string", pattern: clipIdPattern },
          clips: {
            type: "array",
            minItems: 1,
            items: { type: "string", pattern: clipIdPattern },
          },
          priority: { type: "integer", minimum: 0 },
          interruptible: { type: "boolean" },
        },
      },
    },
  },
};

export const assetManifestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "algorithm", "files"],
  properties: {
    schemaVersion: { const: 1 },
    algorithm: { const: "sha256" },
    files: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "sha256", "bytes"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 240 },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          bytes: {
            type: "integer",
            minimum: 0,
            maximum: 64 * 1024 * 1024,
          },
        },
      },
    },
  },
};

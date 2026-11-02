// 退役只针对旧内置默认的精确身份，不限制用户自定义包或正式默认版本。
export function assertPackNotRetired(pack) {
  if (pack.id === "xiaozhao-default" && pack.name === "小招 · 招财猫" && pack.version === "1.0.0") {
    throw new Error("Retired built-in default xiaozhao-default@1.0.0 (小招 · 招财猫); preserved without overwrite. Explicitly import the official pack with install-pack.mjs <source-pack-dir> --packs-dir <dir>.");
  }
}

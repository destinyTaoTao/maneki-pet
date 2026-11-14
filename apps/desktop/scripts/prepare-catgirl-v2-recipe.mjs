import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const recipes = resolve(import.meta.dirname, "../recipes");
const base = JSON.parse(readFileSync(resolve(recipes, "orange-catgirl-release-v1.1.0.json"), "utf8"));
const sourceRoot = "../../../renders/orange-catgirl/signature-actions/v2.0.0/sources";
const actions = [
  "bow", "clap", "dance", "spin", "jump", "salute",
  "finger-heart", "cover-laugh", "look-around", "excited-rub",
];

for (const id of actions) {
  const source = resolve(recipes, sourceRoot, `${id}.mp4`);
  if (!existsSync(source)) throw new Error(`Missing accepted source for ${id}: ${source}`);
  base.clips[id] = {
    input: `${sourceRoot}/${id}.mp4`,
    crop: { x: 144, y: 0, width: 448, height: 416 },
    loop: "forward",
  };
  base.actions.push({ id, clips: [id], priority: 1, interruptible: true });
}
base.id = "xiaozhao-expanded-candidate";
base.name = "小招 · 三色共享动作候选";
base.version = "2.0.0";
if (base.actions.length !== 20) throw new Error(`Expected 20 actions, got ${base.actions.length}`);
if (Object.keys(base.clips).length !== 27) throw new Error(`Expected 27 clips, got ${Object.keys(base.clips).length}`);
writeFileSync(resolve(recipes, "orange-catgirl-release-v2.0.0.json"), `${JSON.stringify(base, null, 2)}\n`);
console.log("Prepared orange-catgirl-release-v2.0.0.json with 27 clips and 20 actions");

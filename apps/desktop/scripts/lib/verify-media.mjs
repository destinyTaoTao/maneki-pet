import { execFileSync } from "node:child_process";

const FORMATS = "png_pipe,webp_pipe,matroska,webm,mov";
const OPTIONS = { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };

/** 安装期完整媒体验证，复用开发素材管线的 FFmpeg，不进入常驻 Runtime。 */
export function verifyMedia(absolute, sources) {
  try {
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", FORMATS,
      "-show_entries", "stream=codec_type,codec_name,width,height:format=format_name", "-of", "json", "-i", absolute,
    ], OPTIONS).toString("utf8"));
    const video = probe.streams?.filter((stream) => stream.codec_type === "video") ?? [];
    if (video.length !== 1) throw new Error("expected one video/image stream");
    const { width, height, codec_name: codec } = video[0];
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 8_388_608) throw new Error("media dimensions exceed pixel budget");
    const formats = String(probe.format?.format_name ?? "").split(",");
    for (const source of sources) {
      const matches = source.mimeType === "image/png" ? codec === "png" && formats.includes("png_pipe")
        : source.mimeType === "image/webp" ? codec === "webp" && formats.includes("webp_pipe")
        : source.mimeType === "video/webm" ? formats.includes("webm") && ["vp8", "vp9", "av1"].includes(codec)
        : source.mimeType === "video/quicktime" && formats.includes("mov");
      if (!matches) throw new Error("actual media format does not match declared MIME");
      if (source.renderer === "spritesheet" && (width !== source.frameWidth * source.frameCount || height !== source.frameHeight)) throw new Error("media dimensions do not match sprite strip");
    }
    execFileSync("ffmpeg", [
      "-nostdin", "-v", "error", "-xerror", "-err_detect", "explode", "-threads", "1",
      "-protocol_whitelist", "file", "-format_whitelist", FORMATS, "-i", absolute,
      "-map", "0:v:0", "-an", "-sn", "-dn", "-f", "null", "-",
    ], OPTIONS);
  } catch (error) {
    // 不回显解码器原始输出；保留工具缺失与校验失败的可诊断区分。
    throw new Error(error?.code === "ENOENT" ? "Media verification requires installed FFmpeg and ffprobe" : "Media format, dimensions or full decoding failed");
  }
}

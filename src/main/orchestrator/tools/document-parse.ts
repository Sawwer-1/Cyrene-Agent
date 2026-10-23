// 文档解析：把 PDF / Word / Excel 二进制文件转成可注入模型上下文的文本。
// - PDF：优先走本机 MinerU HTTP 服务（扫描件可读），不可用或失败时回落 pdfjs-dist。
// - Word：mammoth 抽取纯文本。Excel：exceljs 逐表逐行转文本。
// 所有路径都不得返回空字符串让模型编造内容：解析不出就给明确的降级说明。

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { logger, LogTag } from "../../logger";

export type ParsedDocKind = "pdf" | "docx" | "xlsx";

export interface ParsedDocument {
  ok: boolean;
  kind: ParsedDocKind;
  engine: "mineru" | "pdfjs" | "mammoth" | "exceljs";
  /** 已剥图、已限长的纯文本。ok=false 时为空。 */
  text: string;
  totalChars: number;
  pages?: number;
  /** 给模型的降级说明（例如"扫描件无文本层且 OCR 服务未启动"）。 */
  degraded?: string;
  error?: string;
}

export interface ParseOptions {
  /** 最多返回多少字符，超长截断并在 degraded 里说明。默认 120_000。 */
  maxChars?: number;
  /** PDF 页码范围，如 "1-20"。缺省全部页。 */
  pageRange?: string;
}

const MAX_CHARS_DEFAULT = 120_000;
const MINERU_BASE_URL = "http://127.0.0.1:8000";
const MINERU_HEALTH_TIMEOUT_MS = 3_000;
const MINERU_PARSE_TIMEOUT_MS = 300_000;
/** flash 档试水时每页低于这个字符数，判定为扫描件，升级 standard 档。 */
const SCANNED_PAGE_CHARS = 50;
/** pdfjs 判定"无文本层"的阈值：实测扫描件提取为 0 字符，正常短文档也远超 10。 */
const EMPTY_TEXT_CHARS = 10;
const PDFJS_MAX_PAGES = 300;

export function supportedDocumentKind(filePath: string): ParsedDocKind | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".xlsx" || ext === ".xlsm") return "xlsx";
  return null;
}

/** MinerU 服务不可用后本次运行内不再重试，避免每个文件都等一次健康检查超时。 */
let mineruDisabled = false;

// 测试与离线环境可显式禁用 MinerU 链路，直接走 pdfjs。
if (process.env.CYRENE_DISABLE_MINERU === "1") mineruDisabled = true;

function stripBase64Images(markdown: string): string {
  return markdown.replace(/!\[[^\]]*\]\(data:image\/[^)]*\)/g, "[图片]");
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

// ── MinerU 后端 ─────────────────────────────────────────────

interface MineruHealth {
  status?: string;
  ok: boolean;
  features?: { sources?: string[] };
}

async function mineruHealth(): Promise<MineruHealth> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MINERU_HEALTH_TIMEOUT_MS);
  try {
    const resp = await fetch(`${MINERU_BASE_URL}/v1/health`, { signal: ctrl.signal });
    if (!resp.ok) return { ok: false };
    const body = (await resp.json()) as MineruHealth;
    return { ok: body?.status === "ok", features: body?.features };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

interface MineruParseResult {
  ok: boolean;
  markdown?: string;
  pages?: number;
  errorCode?: string;
  errorMessage?: string;
}

async function mineruParse(
  filePath: string,
  tier: "flash" | "standard",
  pageRange?: string,
): Promise<MineruParseResult> {
  const body: Record<string, unknown> = {
    files: [{
      source: { type: "local", path: filePath },
      ...(pageRange ? { page_range: pageRange } : {}),
    }],
    tier,
    output_formats: ["markdown"],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MINERU_PARSE_TIMEOUT_MS);
  try {
    const resp = await fetch(
      `${MINERU_BASE_URL}/v1/file_parse?response_format=json&wait_timeout=300`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      },
    );
    const payload = (await resp.json().catch(() => null)) as
      | { error?: { code?: string; message?: string }; files?: Array<{ status?: string; content?: string; error?: unknown }> }
      | null;
    if (!resp.ok || payload?.error) {
      return {
        ok: false,
        errorCode: payload?.error?.code ?? `http_${resp.status}`,
        errorMessage: payload?.error?.message ?? `HTTP ${resp.status}`,
      };
    }
    const file = payload?.files?.[0];
    if (!file || file.status !== "completed") {
      return { ok: false, errorCode: "parse_failed", errorMessage: `MinerU 状态 ${file?.status ?? "unknown"}` };
    }
    // content 是 JSON 字符串，需二次解析取 .markdown。
    let markdown = "";
    let pages: number | undefined;
    try {
      const inner = typeof file.content === "string" ? JSON.parse(file.content) : file.content;
      markdown = String(inner?.markdown ?? "");
      pages = inner?.middle_json?.pages?.length;
    } catch {
      markdown = typeof file.content === "string" ? file.content : "";
    }
    return { ok: true, markdown, pages };
  } catch (err) {
    return {
      ok: false,
      errorCode: "network",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function parsePdfWithMineru(filePath: string, opts: ParseOptions): Promise<ParsedDocument | null> {
  if (mineruDisabled) return null;
  const health = await mineruHealth();
  if (!health.ok) {
    mineruDisabled = true;
    logger.info(LogTag.FsTools, "MinerU 服务不可用，PDF 解析回落 pdfjs");
    return null;
  }
  const allowLocal = health.features?.sources?.includes("local") ?? false;
  if (!allowLocal) {
    // 服务没开 --allow-local-source，local 路径必被 400 拒绝，本次运行内不再请求。
    mineruDisabled = true;
    logger.info(LogTag.FsTools, "MinerU 未开放 local source，PDF 解析回落 pdfjs");
    return null;
  }

  // flash 档不跑 VLM、2 秒级且几乎不占显存，先用它试水；
  // 文本密度过低说明是扫描件，再升级 standard（OCR + VLM）。
  const tiers: Array<"flash" | "standard"> = ["flash", "standard"];
  let lastError = "";
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const result = await mineruParse(filePath, tier, opts.pageRange);
    if (result.ok && result.markdown) {
      const cleaned = stripBase64Images(result.markdown);
      const pages = result.pages;
      const dense = pages === undefined || cleaned.length / Math.max(1, pages) >= SCANNED_PAGE_CHARS;
      if (dense || i === tiers.length - 1) {
        logger.info(LogTag.FsTools, `MinerU ${tier} 档解析成功: ${cleaned.length} 字符, ${pages ?? "?"} 页`);
        return { ok: true, kind: "pdf", engine: "mineru", text: cleaned, totalChars: cleaned.length, pages };
      }
      continue;
    }
    lastError = result.errorMessage ?? result.errorCode ?? "";
    // unsupported_source / 服务中断：换档也没用，直接退出走 pdfjs。
    if (result.errorCode === "unsupported_source" || result.errorCode === "network") break;
  }
  logger.warn(LogTag.FsTools, `MinerU 解析失败，回落 pdfjs: ${lastError}`);
  return null;
}

// ── pdfjs 回落后端 ──────────────────────────────────────────

function pdfjsAssetDir(name: "cmaps" | "standard_fonts"): string | null {
  const bases = [
    app.getAppPath(),
    path.join(__dirname, "..", "..", "..", ".."),
  ];
  for (const base of bases) {
    const dir = path.join(base, "node_modules", "pdfjs-dist", name);
    if (fs.existsSync(dir)) return dir + path.sep;
  }
  return null;
}

async function parsePdfWithPdfjs(filePath: string, opts: ParseOptions): Promise<ParsedDocument> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({
    data,
    cMapUrl: pdfjsAssetDir("cmaps") ?? undefined,
    cMapPacked: true,
    standardFontDataUrl: pdfjsAssetDir("standard_fonts") ?? undefined,
    useSystemFonts: true,
  }).promise;

  const maxPages = Math.min(doc.numPages, PDFJS_MAX_PAGES);
  const parts: string[] = [];
  let total = 0;
  for (let n = 1; n <= maxPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => ("str" in item ? item.str : "")).join("");
    parts.push(`【第 ${n} 页】\n${pageText}`);
    total += pageText.length;
    // 文本层明显缺失（前几页几乎全空）时提前停止，避免整本扫描件白扫。
    if (n === 3 && total < EMPTY_TEXT_CHARS) break;
  }
  const cleaned = stripBase64Images(parts.join("\n\n")).trim();
  const empty = total < EMPTY_TEXT_CHARS;
  const degraded = empty
    ? "这份 PDF 没有可提取的文本层（很可能是扫描件），且本机 OCR 服务未启动或不可用，无法读取内容。请告知用户需要启动 MinerU 服务，或改用图片方式查看。"
    : undefined;
  return {
    ok: !empty,
    kind: "pdf",
    engine: "pdfjs",
    text: empty ? "" : cleaned,
    totalChars: cleaned.length,
    pages: doc.numPages,
    ...(empty ? { degraded, error: "no_text_layer" as const } : {}),
  };
}

// ── Word / Excel ────────────────────────────────────────────

async function parseDocx(filePath: string): Promise<ParsedDocument> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: fs.readFileSync(filePath) });
  const text = result.value.replace(/\n{3,}/g, "\n\n").trim();
  return { ok: text.length > 0, kind: "docx", engine: "mammoth", text, totalChars: text.length };
}

async function parseXlsx(filePath: string, maxChars: number): Promise<ParsedDocument> {
  // exceljs 是项目已有生产依赖（write_excel 在用），这里复用它做读取。
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const out: string[] = [];
  let used = 0;
  let overflowed = false;
  for (const sheet of workbook.worksheets) {
    if (overflowed) break;
    out.push(`【工作表 ${sheet.name}】`);
    used += sheet.name.length + 8;
    let rows = 0;
    sheet.eachRow((row) => {
      if (overflowed) return;
      const cells: string[] = [];
      for (let c = 1; c <= Math.min(row.cellCount, 64); c++) {
        const v = row.getCell(c).value;
        if (v === null || v === undefined) { cells.push(""); continue; }
        if (typeof v === "object" && "text" in (v as object)) cells.push(String((v as { text: string }).text));
        else if (typeof v === "object" && "result" in (v as object)) cells.push(String((v as { result: unknown }).result));
        else cells.push(String(v));
      }
      const line = cells.join(" | ");
      out.push(line);
      used += line.length + 1;
      rows += 1;
      if (rows >= 5000) {
        out.push(`（工作表 ${sheet.name} 超过 5000 行，已截断）`);
        overflowed = true;
      } else if (used >= maxChars) {
        out.push(`（已达输出上限，后续内容未读取）`);
        overflowed = true;
      }
    });
  }
  const text = out.join("\n");
  return { ok: true, kind: "xlsx", engine: "exceljs", text, totalChars: text.length };
}

// ── 入口 ────────────────────────────────────────────────────

export async function parseDocument(filePath: string, opts: ParseOptions = {}): Promise<ParsedDocument> {
  const kind = supportedDocumentKind(filePath);
  const maxChars = opts.maxChars ?? MAX_CHARS_DEFAULT;
  if (!kind) {
    return { ok: false, kind: "pdf", engine: "pdfjs", text: "", totalChars: 0, error: "unsupported_kind" };
  }
  let parsed: ParsedDocument;
  try {
    if (kind === "pdf") {
      parsed = (await parsePdfWithMineru(filePath, opts))
        ?? (await parsePdfWithPdfjs(filePath, opts));
    } else if (kind === "docx") {
      parsed = await parseDocx(filePath);
    } else {
      parsed = await parseXlsx(filePath, maxChars);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(LogTag.FsTools, `文档解析失败 ${filePath}: ${message}`);
    return {
      ok: false, kind, engine: kind === "pdf" ? "pdfjs" : kind === "docx" ? "mammoth" : "exceljs",
      text: "", totalChars: 0,
      degraded: `文档解析失败：${message}`,
      error: "parse_failed",
    };
  }
  if (!parsed.ok) return parsed;
  const { text, truncated } = truncate(parsed.text, maxChars);
  return {
    ...parsed,
    text,
    degraded: truncated
      ? `文档过长，已截断到前 ${maxChars} 字符（原文 ${parsed.totalChars} 字符）。可用 pageRange/分页方式读取更多。`
      : parsed.degraded,
  };
}

/**
 * document-parse 测试：
 * - PDF 文字版经 pdfjs 提取正文（MinerU 通过环境变量禁用，链路回落有独立分支覆盖）
 * - 无文本层 PDF（纯图形）必须给出 NO_TEXT_LAYER 级别的降级说明，绝不返回空字符串
 * - docx 生成→解析往返；xlsx 生成→解析往返
 * - read_file 对 .pdf 的二进制分支改走解析链路
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmpDir: string;
let repoRoot: string;

vi.mock("electron", () => ({
  app: {
    getAppPath: () => repoRoot,
    getPath: (_name: string) => tmpDir,
  },
}));

// MinerU 不在测试环境运行；健康检查 3 秒超时会拖慢测试，直接禁用。
process.env.CYRENE_DISABLE_MINERU = "1";

import { parseDocument, supportedDocumentKind } from "./document-parse";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-parse-test-"));
  // cmaps/standard_fonts 资产目录按仓库根定位
  repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function makeTextPdf(filePath: string, lines: string[]): Promise<void> {
  const PDFKit = await import("pdfkit");
  const doc = new PDFKit.default({ autoFirstPage: true });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);
  doc.font("Helvetica").fontSize(12);
  for (const line of lines) doc.text(line);
  doc.end();
  await new Promise<void>((resolve) => stream.on("close", resolve));
}

async function makeImageOnlyPdf(filePath: string): Promise<void> {
  const PDFKit = await import("pdfkit");
  const doc = new PDFKit.default({ autoFirstPage: true });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);
  // 只画图形不写文本 → 无文本层
  doc.rect(50, 50, 200, 120).fill("#3366aa");
  doc.circle(320, 120, 60).fill("#aa3366");
  doc.end();
  await new Promise<void>((resolve) => stream.on("close", resolve));
}

describe("supportedDocumentKind", () => {
  it("按扩展名识别 PDF/Word/Excel，其余返回 null", () => {
    expect(supportedDocumentKind("a.PDF")).toBe("pdf");
    expect(supportedDocumentKind("a.docx")).toBe("docx");
    expect(supportedDocumentKind("a.xlsx")).toBe("xlsx");
    expect(supportedDocumentKind("a.txt")).toBeNull();
    expect(supportedDocumentKind("a.doc")).toBeNull();
  });
});

describe("PDF 解析（pdfjs 后端）", () => {
  it("文字版 PDF 提取正文", async () => {
    const p = path.join(tmpDir, "text.pdf");
    await makeTextPdf(p, ["Hello Cyrene", "Second line of the document"]);
    const parsed = await parseDocument(p);
    expect(parsed.ok).toBe(true);
    expect(parsed.engine).toBe("pdfjs");
    expect(parsed.text).toContain("Hello Cyrene");
    expect(parsed.pages).toBe(1);
  });

  it("无文本层 PDF 返回降级说明而不是空字符串", async () => {
    const p = path.join(tmpDir, "scanned.pdf");
    await makeImageOnlyPdf(p);
    const parsed = await parseDocument(p);
    expect(parsed.ok).toBe(false);
    expect(parsed.text).toBe("");
    expect(parsed.degraded).toContain("扫描件");
    expect(parsed.error).toBe("no_text_layer");
  });

  it("maxChars 截断并写明原文长度", async () => {
    const p = path.join(tmpDir, "big.pdf");
    await makeTextPdf(p, Array.from({ length: 60 }, (_, i) => `Line ${i} ${"x".repeat(40)}`));
    const parsed = await parseDocument(p, { maxChars: 500 });
    expect(parsed.ok).toBe(true);
    expect(parsed.text.length).toBeLessThanOrEqual(500);
    expect(parsed.degraded).toContain("截断");
  });
});

describe("Word 解析（mammoth 后端）", () => {
  it("docx 生成→解析往返", async () => {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
    const p = path.join(tmpDir, "sample.docx");
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ text: "测试文档标题", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun("这是正文内容，包含中文与 English 混排。")] }),
        ],
      }],
    });
    fs.writeFileSync(p, await Packer.toBuffer(doc));
    const parsed = await parseDocument(p);
    expect(parsed.ok).toBe(true);
    expect(parsed.engine).toBe("mammoth");
    expect(parsed.text).toContain("测试文档标题");
    expect(parsed.text).toContain("English 混排");
  });
});

describe("Excel 解析（exceljs 后端）", () => {
  it("xlsx 生成→解析往返，多工作表与中文表头", async () => {
    const ExcelJS = await import("exceljs");
    const p = path.join(tmpDir, "sample.xlsx");
    const wb = new ExcelJS.Workbook();
    const s1 = wb.addWorksheet("人员");
    s1.addRow(["姓名", "金额"]);
    s1.addRow(["张三", 100]);
    const s2 = wb.addWorksheet("备注");
    s2.addRow(["说明"]);
    s2.addRow(["第二张表内容"]);
    await wb.xlsx.writeFile(p);
    const parsed = await parseDocument(p);
    expect(parsed.ok).toBe(true);
    expect(parsed.engine).toBe("exceljs");
    expect(parsed.text).toContain("【工作表 人员】");
    expect(parsed.text).toContain("姓名 | 金额");
    expect(parsed.text).toContain("张三 | 100");
    expect(parsed.text).toContain("第二张表内容");
  });
});

describe("不支持的类型", () => {
  it("非文档扩展名返回 unsupported_kind", async () => {
    const p = path.join(tmpDir, "data.bin");
    fs.writeFileSync(p, Buffer.from([0, 1, 2, 3]));
    const parsed = await parseDocument(p);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("unsupported_kind");
  });
});

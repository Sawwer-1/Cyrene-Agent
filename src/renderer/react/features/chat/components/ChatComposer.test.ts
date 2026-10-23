import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

let senderProps: Record<string, unknown> | undefined;

vi.mock("@ant-design/x", () => ({
  Sender: (props: Record<string, unknown>) => {
    senderProps = props;
    return null;
  },
  Suggestion: ({ children }: { children: (props: { onTrigger: () => void; onKeyDown: () => void; open: boolean }) => unknown }) =>
    children({ onTrigger: () => undefined, onKeyDown: () => undefined, open: false }),
}));

vi.mock("antd", () => ({
  Popover: ({ children }: { children?: unknown }) => children ?? null,
  Segmented: () => null,
}));

vi.mock("./ReasoningControl", () => ({ ReasoningControl: () => null }));
vi.mock("./StyleControl", () => ({ StyleControl: () => null }));
vi.mock("./PermissionControl", () => ({ PermissionControl: () => null }));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));

import { ChatComposer, parseComposerMessage } from "./ChatComposer";

describe("ChatComposer cancellation", () => {
  beforeEach(() => {
    senderProps = undefined;
  });

  it("forwards cancellation to the Sender stop button", () => {
    const onCancel = vi.fn();
    vi.stubGlobal("React", React);

    renderToStaticMarkup(createElement(ChatComposer, {
      value: "",
      mode: "chat",
      docked: true,
      attachments: [],
      modelBusy: true,
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onCancel,
      onChooseWorkspace: vi.fn(),
      onChooseFiles: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onScreenshot: vi.fn(),
      onChooseSticker: vi.fn(),
    }));

    expect(senderProps?.onCancel).toBe(onCancel);
  });

  it("does not disable an active Work run when its workspace label is not loaded", () => {
    vi.stubGlobal("React", React);

    renderToStaticMarkup(createElement(ChatComposer, {
      value: "",
      mode: "work",
      docked: true,
      attachments: [],
      modelBusy: true,
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
      onChooseWorkspace: vi.fn(),
      onChooseFiles: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onScreenshot: vi.fn(),
      onChooseSticker: vi.fn(),
    }));

    expect(senderProps?.disabled).toBe(false);
  });

});

describe("ChatComposer Code sticker policy", () => {
  const baseProps = {
    value: "",
    docked: true,
    workspaceName: "project",
    attachments: [],
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onChooseWorkspace: vi.fn(),
    onChooseFiles: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onScreenshot: vi.fn(),
    onChooseSticker: vi.fn(),
  };

  it("shows the sticker picker in work mode (v2: 门控随 code 槽位退役)", () => {
    renderToStaticMarkup(createElement(ChatComposer, { ...baseProps, mode: "work" }));
    const workHtml = renderToStaticMarkup(senderProps?.prefix as React.ReactElement);
    expect(workHtml).toContain('aria-label="表情包"');
  });

  it("parses sticker markers in work mode (v2: 剥离特例随 code 槽位退役)", () => {
    expect(parseComposerMessage("work", "检查一下 [sticker:playful]")).toEqual({
      rawContent: "检查一下 [sticker:playful]",
      visibleContent: "检查一下",
      userSticker: "playful",
    });
  });

  it("keeps the plan mode toggle in the Code composer footer", () => {
    const html = renderToStaticMarkup(createElement(ChatComposer, {
      ...baseProps,
      mode: "work",
      conversationId: "session-1",
    }));

    expect(html).toContain("计划模式 · off");
    expect(html).toContain("cy-plan-control");
  });
});

describe("ChatComposer workspace switch lock", () => {
  const baseProps = {
    value: "",
    docked: true,
    attachments: [],
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onChooseWorkspace: vi.fn(),
    onChooseFiles: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onScreenshot: vi.fn(),
    onChooseSticker: vi.fn(),
  };

  it("会话开启且已绑定工作区后隐藏切换入口：换工作区 = 新开对话", () => {
    const html = renderToStaticMarkup(createElement(ChatComposer, {
      ...baseProps,
      mode: "work",
      conversationId: "session-1",
      workspaceRoot: "E:/proj",
      workspaceName: "proj",
    }));

    expect(html).not.toContain('aria-label="选择工作文件夹"');
  });

  it("开始对话前（无会话）保留工作区选择入口", () => {
    const html = renderToStaticMarkup(createElement(ChatComposer, {
      ...baseProps,
      mode: "work",
    }));

    expect(html).toContain('aria-label="选择工作文件夹"');
  });

  it("会话存在但未绑定（绑定失败的补救场景）仍显示选择入口", () => {
    const html = renderToStaticMarkup(createElement(ChatComposer, {
      ...baseProps,
      mode: "work",
      conversationId: "session-1",
    }));

    expect(html).toContain('aria-label="选择工作文件夹"');
  });
});

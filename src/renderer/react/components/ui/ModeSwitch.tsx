import { SegmentedControl } from "@mantine/core";
import { BookOpen, Landmark, MessageCircle, Monitor } from "lucide-react";

interface ModeSwitchProps {
  value: string;
  onChange: (mode: string) => void;
}

const iconProps = {
  size: 15,
  strokeWidth: 1.8,
  "aria-hidden": true as const,
  focusable: false as const,
};

// v2 槽位重定义：聊天 / 研究 / 法律 / 工作（原 Learn→Research，Code 并入 Work）
const modes = [
  { value: "work", label: <><Monitor {...iconProps} /><span>Work</span></> },
  { value: "chat", label: <><MessageCircle {...iconProps} /><span>Chat</span></> },
  { value: "research", label: <><BookOpen {...iconProps} /><span>Research</span></> },
  { value: "legal", label: <><Landmark {...iconProps} /><span>Legal</span></> },
];

export function ModeSwitch({ value, onChange }: ModeSwitchProps) {
  return (
    <SegmentedControl
      aria-label="Conversation mode"
      classNames={{
        root: "cy-mode-switch",
        control: "cy-mode-switch__control",
        input: "cy-mode-switch__input",
        label: "cy-mode-switch__label",
        indicator: "cy-mode-switch__indicator",
        innerLabel: "cy-mode-switch__content",
      }}
      name="conversation-mode"
      onChange={onChange}
      data={modes}
      value={value}
      size="sm"
      radius="md"
      transitionDuration={180}
      withItemsBorders={false}
    />
  );
}

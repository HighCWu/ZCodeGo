import {
  Code2,
  ShieldCheck,
  PanelsTopLeft,
  PenTool,
  GraduationCap,
  Video,
  Store,
  Megaphone,
  BriefcaseBusiness,
  Rocket,
  Scale,
  Ellipsis,
  Building2,
  type LucideIcon,
} from "lucide-react";

export const occupations = [
  "developer",
  "independent",
  "infrastructure",
  "product",
  "design",
  "student",
  "finance",
  "creator",
  "operations",
  "marketing",
  "legal",
  "other",
] as const;

export type OccupationValue = (typeof occupations)[number];

/** 步骤 2 模式选择用的图标：coding / office。 */
export const modeOptionIcons = {
  coding: Code2,
  office: PanelsTopLeft,
  // zcode-go：OPC 公司模式（AI 原生公司界面）
  opc: Building2,
} as const;

const occupationIcons = [
  Code2,
  Rocket,
  ShieldCheck,
  PanelsTopLeft,
  PenTool,
  GraduationCap,
  BriefcaseBusiness,
  Video,
  Store,
  Megaphone,
  Scale,
  Ellipsis,
];

export function getOccupationIcon(index: number): LucideIcon {
  return occupationIcons[index] ?? Ellipsis;
}

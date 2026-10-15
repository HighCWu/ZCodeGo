export type InterfaceMode = "office" | "coding" | "opc"; // zcode-go：新增 opc（OPC 公司模式，见 specs/opc-mode.md）

export const INTERFACE_MODE_STORAGE_KEY = "zcode-interface-mode";

export function normalizeInterfaceMode(value: unknown): InterfaceMode {
  // zcode-go：opc 模式直通（OPC 公司模式是第三种界面模式）。
  if (value === "opc") return "opc";
  // localStorage（zcode-interface-mode）里可能还存着改名前的旧值 "general"/"concise"，
  // 必须映射到新名 office，否则这些存量用户升级后会被归一成 coding，静默丢失选择。
  return value === "office" || value === "general" || value === "concise" ? "office" : "coding";
}

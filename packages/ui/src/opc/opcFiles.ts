/**
 * zcode-go OPC 文件下载/读取助手（renderer 侧，公司包与技能导出用）。
 * 纯浏览器 API（Blob/FileReader），不涉及 fs。
 */

export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function readFileText(file: File): Promise<string> {
  return file.text();
}

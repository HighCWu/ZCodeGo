import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";

export function useIsOfficeMode(): boolean {
  return useZCodeStoreWithDefault((state) => state.interfaceMode === "office", false);
}

// zcode-go：OPC 公司模式判定（驾驶舱/公司面板的门控依据）。
export function useIsOpcMode(): boolean {
  return useZCodeStoreWithDefault((state) => state.interfaceMode === "opc", false);
}

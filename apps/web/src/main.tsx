import { render } from "preact";
import { App } from "./app";
import { initializeAppearance } from "./appearance";
import { connectChatApi } from "./chat-api";
import { createKanbanApi } from "./kanban-api";
import { connectOfficeApi } from "./office-api";
import { createTeamsApi, refreshTeams, registerTeamsRuntime } from "./teams-store";
import { isLocalOfficeClient } from "./auth-state";
import { notifyAccessAuditChanged, shouldRefreshAccessAudit } from "./audit-api";
import { initializeI18n } from "./i18n";
import { initializeInventory, registerInventorySnapshotRefresh } from "./inventory";
import {
  applyChatGatewayEvent,
  applyChatHistory,
  applyOfficeSnapshot,
  installMobileRouteHistory,
  requireDeviceLogin,
  registerChatRuntime,
  registerKanbanRuntime,
  registerOfficeRetry,
  refreshKanbanBoard,
  setOfficeAccessUnavailable,
  setOfficeAuthenticated,
  setChatHistoryError,
  setChatHistoryLoading,
  setChatSessionConnecting,
  setChatSessionDisconnected,
  setChatSessionError,
  setChatSessionReady,
  setChatSocketState,
  setOfficeConnecting,
  setOfficeError,
  setOfficeEventStream
} from "./store";
import "./fonts.css";
import "./styles.css";
import "./components/avatar-picker.css";
import "./components/teams-panel.css";
import "./components/profile-groups.css";
import "./appearance.css";

initializeAppearance();
initializeI18n();
installMobileRouteHistory();
render(<App />, document.getElementById("app")!);

let chatApi: ReturnType<typeof connectChatApi> | undefined;
let authenticatedServicesStarted = false;

function startAuthenticatedServices(): void {
  if (authenticatedServicesStarted) return;
  authenticatedServicesStarted = true;
  registerKanbanRuntime(createKanbanApi());
  registerTeamsRuntime(createTeamsApi());
  chatApi = connectChatApi({
    onSocketState: setChatSocketState,
    onHistoryLoading: setChatHistoryLoading,
    onHistory: applyChatHistory,
    onHistoryError: setChatHistoryError,
    onSessionConnecting: setChatSessionConnecting,
    onSessionReady: setChatSessionReady,
    onSessionDisconnected: setChatSessionDisconnected,
    onSessionError: setChatSessionError,
    onEvent: applyChatGatewayEvent
  });
  registerChatRuntime(chatApi);
}

const officeApi = connectOfficeApi({
  onConnecting: setOfficeConnecting,
  onSnapshot(snapshot, identity) {
    if (!applyOfficeSnapshot(snapshot, identity)) return;
    initializeInventory(snapshot, identity);
    setOfficeAuthenticated(identity.serverUrl);
    startAuthenticatedServices();
    if (snapshot.capabilities.runtime.state === "ready") {
      void refreshKanbanBoard();
      void refreshTeams({ acknowledgeErrors: true });
    } else if (!snapshot.capabilities.features.includes("demo")) {
      void refreshTeams({ acknowledgeErrors: true });
    }
  },
  onEventStream: setOfficeEventStream,
  onAuthRequired: requireDeviceLogin,
  onRecoveryUnavailable: (message, serverUrl) => setOfficeError(message, serverUrl, true),
  onError(message, serverUrl) {
    setOfficeError(message, serverUrl);
    if (isLocalOfficeClient(location)) setOfficeAuthenticated(serverUrl);
    // Keep the concrete server/client error when present so snapshot/auth
    // incompatibilities are not remapped to a generic network outage.
    else setOfficeAccessUnavailable(serverUrl, message.trim() || "Office Serverへ接続できませんでした。ネットワークを確認してください。");
  },
  onEvent(event) {
    if (event.topic === "kanban.changed" || event.topic === "resync.required") void refreshKanbanBoard();
    if (event.topic === "access.changed" && shouldRefreshAccessAudit(event.payload)) notifyAccessAuditChanged();
  }
});
registerOfficeRetry(() => {
  officeApi.retry();
  chatApi?.retry();
});
registerInventorySnapshotRefresh((expected) => officeApi.refresh(expected));

window.addEventListener("beforeunload", () => {
  chatApi?.stop();
  officeApi.stop();
}, { once: true });

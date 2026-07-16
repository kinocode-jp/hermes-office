import { render } from "preact";
import { App } from "./app";
import { initializeAppearance } from "./appearance";
import { connectChatApi } from "./chat-api";
import { createKanbanApi } from "./kanban-api";
import { connectOfficeApi } from "./office-api";
import { isLocalOfficeClient } from "./auth-state";
import { notifyAccessAuditChanged, shouldRefreshAccessAudit } from "./audit-api";
import { initializeI18n } from "./i18n";
import {
  applyChatGatewayEvent,
  applyChatHistory,
  applyOfficeSnapshot,
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
import "./styles.css";
import "./components/avatar-picker.css";
import "./appearance.css";

initializeAppearance();
initializeI18n();
render(<App />, document.getElementById("app")!);

let chatApi: ReturnType<typeof connectChatApi> | undefined;
let authenticatedServicesStarted = false;

function startAuthenticatedServices(): void {
  if (authenticatedServicesStarted) return;
  authenticatedServicesStarted = true;
  registerKanbanRuntime(createKanbanApi());
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
  onSnapshot(snapshot, serverUrl) {
    applyOfficeSnapshot(snapshot, serverUrl);
    setOfficeAuthenticated(serverUrl);
    startAuthenticatedServices();
    if (snapshot.capabilities.runtime.state === "ready") void refreshKanbanBoard();
  },
  onEventStream: setOfficeEventStream,
  onAuthRequired: requireDeviceLogin,
  onError(message, serverUrl) {
    setOfficeError(message, serverUrl);
    if (isLocalOfficeClient(location)) setOfficeAuthenticated(serverUrl);
    else setOfficeAccessUnavailable(serverUrl, "Office Serverへ接続できませんでした。ネットワークを確認してください。");
  },
  onEvent(event) {
    if (event.topic === "kanban.changed" || event.topic === "resync.required") void refreshKanbanBoard();
    if (event.topic === "access.changed" && shouldRefreshAccessAudit(event.payload)) notifyAccessAuditChanged();
  }
});
registerOfficeRetry(() => officeApi.retry());

window.addEventListener("beforeunload", () => {
  chatApi?.stop();
  officeApi.stop();
}, { once: true });

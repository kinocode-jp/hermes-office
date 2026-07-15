import { render } from "preact";
import { App } from "./app";
import { connectOfficeApi } from "./office-api";
import { applyOfficeSnapshot, registerOfficeRetry, setOfficeConnecting, setOfficeError, setOfficeEventStream } from "./store";
import "./styles.css";

render(<App />, document.getElementById("app")!);

const officeApi = connectOfficeApi({
  onConnecting: setOfficeConnecting,
  onSnapshot: applyOfficeSnapshot,
  onEventStream: setOfficeEventStream,
  onError: setOfficeError
});
registerOfficeRetry(() => officeApi.retry());

window.addEventListener("beforeunload", () => officeApi.stop(), { once: true });

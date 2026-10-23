// The connect screen: the app's first page until a PC is chosen. Opening a PC goes through the
// native HerdrShell plugin, which makes the PC's address the WebView's first page: navigating
// there from this page would cost every launch about 1.5 s (docs/native-app.md, Spike results).
import { localize, parseAddress, publicHttp, shell, t } from "./shell.js";

localize();

// only iOS opens a plain http PC slower (docs/native-app.md, The app); Android shows no such delay
if (window.Capacitor?.getPlatform?.() !== "ios") document.querySelector(".hint")?.remove();

const form = document.getElementById("connect");
const input = document.getElementById("address");
const error = document.getElementById("error");
/** PCs that loaded before, and the public http address the user was just warned about. */
let savedOrigins = [];
let warned = "";

async function open(text) {
  const url = parseAddress(text);
  if (url === null) { error.textContent = t("That is not an http or https address.", "http 또는 https 주소가 아닙니다."); input.focus(); return; }
  if (publicHttp(url) && !savedOrigins.some((saved) => new URL(saved).origin === url.origin) && warned !== url.href) {
    warned = url.href;
    error.textContent = t(
      `${url.host} is not on a tailnet or a home network, so plain http would send the pairing code and everything you type across the internet unencrypted. Use its https address, or open it again to go ahead.`,
      `${url.host}은(는) tailnet이나 집 네트워크의 주소가 아니어서, 일반 http로는 페어링 코드와 입력하는 모든 내용이 암호화되지 않은 채 인터넷으로 오갑니다. https 주소를 쓰거나, 그래도 열려면 한 번 더 여세요.`,
    );
    return;
  }
  error.textContent = "";
  try { await shell("open", { url: url.href }); }
  catch (err) { error.textContent = String(err?.message ?? err); }
}

form.addEventListener("submit", (event) => { event.preventDefault(); void open(input.value); });

document.getElementById("scan").addEventListener("click", async () => {
  error.textContent = "";
  try {
    // the plugin's own JS fills these defaults; this page calls the bridge without it
    const result = await window.Capacitor.nativePromise("CapacitorBarcodeScanner", "scanBarcode", { hint: 0, scanInstructions: t("Point at the QR code under Settings → Phone & devices on your PC", "PC의 설정 → 폰 및 기기에 있는 QR 코드를 비추세요"), scanButton: false, scanText: " ", cameraDirection: 1, scanOrientation: 3 });
    if (result?.ScanResult) await open(result.ScanResult);
  } catch (err) {
    error.textContent = String(err?.message ?? err);
  }
});

function renderSaved(saved, current) {
  const list = document.getElementById("saved");
  list.replaceChildren();
  for (const origin of saved) {
    const item = document.createElement("li");
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "open";
    openButton.textContent = origin === current ? `${origin} ${t("(last opened)", "(마지막으로 연 PC)")}` : origin;
    openButton.addEventListener("click", () => void open(origin));
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "forget";
    forget.textContent = t("Forget", "지우기");
    forget.setAttribute("aria-label", t(`Forget ${origin}`, `${origin} 지우기`));
    forget.addEventListener("click", async () => { await shell("forget", { url: origin }); await load(); });
    item.append(openButton, forget);
    list.append(item);
  }
  document.getElementById("saved-section").hidden = saved.length === 0;
}

async function load() {
  const state = await shell("getState");
  savedOrigins = state.saved ?? [];
  renderSaved(savedOrigins, state.last ?? "");
}

void load();

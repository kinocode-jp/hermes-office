import { useState } from "preact/hooks";
import {
  addGlobalSkill,
  globalSettings,
  removeGlobalSkill,
  setGlobalSettings
} from "../store";

export function LibraryPage() {
  const [skill, setSkill] = useState("");
  const settings = globalSettings.value;

  return (
    <section class="control-page">
      <header class="page-title-row">
        <div><p class="eyebrow">Shared capabilities</p><h1>会社ライブラリ</h1></div>
        <span class="scope-badge">GLOBAL</span>
      </header>
      <div class="control-grid">
        <article class="control-card">
          <span class="card-kicker">GLOBAL SKILLS</span>
          <h2>全Profileへ継承</h2>
          <div class="editable-tags">
            {settings.skills.map((item) => <button key={item} onClick={() => removeGlobalSkill(item)} title="クリックして削除">{item}<i>×</i></button>)}
          </div>
          <form class="inline-add" onSubmit={(event) => { event.preventDefault(); addGlobalSkill(skill); setSkill(""); }}>
            <input value={skill} onInput={(event) => setSkill(event.currentTarget.value)} placeholder="skill-name" aria-label="Global Skill名" />
            <button type="submit">追加</button>
          </form>
        </article>
        <article class="control-card wide-card">
          <span class="card-kicker">GLOBAL CONTEXT</span>
          <h2>共通Memory</h2>
          <textarea value={settings.context} onInput={(event) => setGlobalSettings({ context: event.currentTarget.value })} rows={8} />
          <p class="setting-note">Office側で継承し、HermesのProfile固有Memoryとは分離します。</p>
        </article>
      </div>
    </section>
  );
}

export function SettingsPage() {
  const mode = globalSettings.value.remoteAccess;
  return (
    <section class="control-page">
      <header class="page-title-row">
        <div><p class="eyebrow">Runtime & access</p><h1>環境設定</h1></div>
        <span class="scope-badge local">LOCAL ONLY</span>
      </header>
      <div class="control-grid">
        <article class="control-card wide-card">
          <span class="card-kicker">HERMES RUNTIME</span>
          <h2>既存のローカルHermesへ接続</h2>
          <div class="connection-row"><i /><div><b>Adapter ready</b><span>接続先は未設定 · demo data</span></div><button disabled>接続設定</button></div>
        </article>
        <article class="control-card">
          <span class="card-kicker">REMOTE ACCESS</span>
          <h2>外出先から操作</h2>
          <label class="radio-option"><input type="radio" checked={mode === "off"} onChange={() => setGlobalSettings({ remoteAccess: "off" })} /><span><b>ローカルのみ</b><small>この端末からだけ利用</small></span></label>
          <label class="radio-option"><input type="radio" checked={mode === "tailscale"} onChange={() => setGlobalSettings({ remoteAccess: "tailscale" })} /><span><b>Tailscale</b><small>推奨。公開せず端末間接続</small></span></label>
          <label class="radio-option"><input type="radio" checked={mode === "public"} onChange={() => setGlobalSettings({ remoteAccess: "public" })} /><span><b>Public + OIDC</b><small>認証・監査設定後のみ</small></span></label>
        </article>
        <article class="control-card">
          <span class="card-kicker">DEVICE POLICY</span>
          <h2>操作権限</h2>
          <div class="policy-row"><span>スマホ閲覧</span><b>許可</b></div>
          <div class="policy-row"><span>Chat・Kanban</span><b>確認不要</b></div>
          <div class="policy-row"><span>Memory削除</span><b class="warning">再認証</b></div>
          <div class="policy-row"><span>秘密情報</span><b class="warning">送信禁止</b></div>
        </article>
      </div>
    </section>
  );
}

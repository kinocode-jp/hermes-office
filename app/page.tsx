import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Hermes Studio — 強力な Hermes エージェントを、誰でもカンタンに",
  description:
    "ターミナル操作なしで、強力な Hermes Agent をだれでも直感的に。チャット・カンバン・チーム設定をひとつのビジュアルUIで扱えます。",
};

const SPRITES = [
  { row: 0, name: "受付", en: "default" },
  { row: 1, name: "フーディン", en: "alakazam" },
  { row: 2, name: "カメックス", en: "blastoise" },
  { row: 3, name: "ラッキー", en: "chansey" },
  { row: 4, name: "リザードン", en: "charizard" },
  { row: 5, name: "ピッピ", en: "clefairy" },
];

function Sprite({ row, size = 72 }: { row: number; size?: number }) {
  return (
    <span
      aria-hidden
      className="sprite"
      style={{
        width: size,
        height: size,
        backgroundPosition: `0% ${(row / 5) * 100}%`,
      }}
    />
  );
}

const FEATURES = [
  {
    title: "ピクセルオフィス・ロスター",
    body:
      "すべての Hermes Profile がアニメーションするオフィスキャラクターに。前/横/後ろの歩行フレーム、カスタムポートレート、安定したデスク配置。7体目以降は決定的な色相バリアントで自動生成されます。",
  },
  {
    title: "マルチペイン・チャット",
    body:
      "最大4つの会話を同時に並べて表示。ストリーミング、ステアリング、割り込み、再接続、正規化されたツールイベントに対応し、会話をドラッグして好きな位置に配置できます。",
  },
  {
    title: "Hermes カンバン",
    body:
      "タスクボードの閲覧と更新、Profile への割り当て、コメント、ライブ更新。タスクケーブルがオフィスの床を走り、誰が何をしているかがひと目でわかります。",
  },
  {
    title: "オフィスチーム",
    body:
      "Hermes Profile を多対多でグルーピング。ロスターバッジ、カンバン由来のチームワークロード表示、チームでのタスク絞り込みに対応します。",
  },
  {
    title: "Skills・SOUL・Memory 設定",
    body:
      "Profile 単位でインストール済み Skills、SOUL、Memory プロバイダー設定を管理。Office 全体の共有コンテキスト層と明示的な継承同期も備えています。",
  },
  {
    title: "日英UI・PWA",
    body:
      "英語/日本語UI、文字サイズ調整、ライト/ダークテーマ、スマートフォン向けレスポンシブナビゲーション、インストール可能な PWA シェル。",
  },
];

export default function Home() {
  return (
    <main className="page">
      <header className="nav">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/lp/icon.png" alt="Hermes Studio" width={36} height={36} />
          <span>
            Hermes <em>Studio</em>
          </span>
        </div>
        <nav className="navlinks" aria-label="ページ内リンク">
          <a href="#features">機能</a>
          <a href="#screens">スクリーンショット</a>
          <a href="#start">はじめる</a>
        </nav>
        <a
          className="pill"
          href="https://github.com/kinocode-jp/hermes-studio"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">実験的・コミュニティプロジェクト</span>
          <h1>
            強力な Hermes エージェントを、
            <span className="hl">誰でもカンタンに</span>。
          </h1>
          <p className="sub">
            <a href="https://github.com/NousResearch/hermes-agent" target="_blank" rel="noreferrer">
              Hermes Agent
            </a>{" "}
            は強力ですが、ターミナルと設定ファイルの世界。Hermes Studio
            はそれをピクセルオフィスのビジュアルUIに変えます。エージェントはオフィスで働くキャラクターとして現れ、チャット・設定・カンバンのタスクをクリックひとつで開けます。コマンドを覚える必要はありません。
          </p>
          <div className="cta-row">
            <a className="cta" href="#start">
              はじめる →
            </a>
            <a className="cta ghost" href="#screens">
              画面を見る
            </a>
          </div>
          <p className="note">
            非公式の独立プロジェクトです。Nous Research の公式プロダクトではありません。
          </p>
        </div>
        <div className="hero-roster" aria-hidden>
          {SPRITES.map((s) => (
            <div className="desk" key={s.en}>
              <Sprite row={s.row} />
              <span className="desk-name">{s.name}</span>
              <span className="desk-id">{s.en}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="why">
        <div className="why-inner">
          <div className="why-col bad">
            <h3>これまで</h3>
            <ul>
              <li>ターミナルでセッションを起動・切替</li>
              <li>タスクの状況はログを追って把握</li>
              <li>複数エージェントの並行作業が見えない</li>
            </ul>
          </div>
          <div className="why-arrow" aria-hidden>
            →
          </div>
          <div className="why-col good">
            <h3>Hermes Studio なら</h3>
            <ul>
              <li>キャラクターをクリックして会話を開始</li>
              <li>カンバンで担当・状態・コメントがひと目でわかる</li>
              <li>最大4つのチャットを並べて同時に進行</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="screens" id="screens">
        <h2>実際の画面</h2>
        <div className="shots">
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/lp/screen-kanban.png" alt="Hermes Studio のタスクボード画面。ステータス列で並んだカンバンと、左のプロファイルロスター" />
            <figcaption>タスクボード — 担当 Profile・状態・コメントをライブに反映</figcaption>
          </figure>
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/lp/screen-chat.png" alt="Hermes Studio の会話ペインをタスクボードの横にドッキングした画面" />
            <figcaption>会話ペイン — タスクボードの横にドッキングして最大4つ並べる</figcaption>
          </figure>
        </div>
      </section>

      <section className="features" id="features">
        <h2>機能</h2>
        <div className="grid">
          {FEATURES.map((f) => (
            <article className="card" key={f.title}>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="start" id="start">
        <div className="start-inner">
          <div>
            <h2>はじめる</h2>
            <p>
              現在はソースビルド専用(pre-1.0)です。Node.js 22.x と Hermes Agent
              が同一OSユーザーにインストールされている必要があります。公開インターネットへ直接公開しないでください。
            </p>
          </div>
          <pre aria-label="セットアップコマンド">
            <code>{`git clone https://github.com/kinocode-jp/hermes-studio
cd hermes-studio
npm install
npm run dev`}</code>
          </pre>
        </div>
        <div className="start-row" aria-hidden>
          {SPRITES.map((s) => (
            <Sprite key={s.en} row={s.row} size={48} />
          ))}
        </div>
      </section>

      <footer className="foot">
        <p>
          Hermes Studio は独立したコミュニティプロジェクトであり、Nous Research
          とは無関係です。公式 Hermes Agent インターフェースを置き換えるものではありません。
        </p>
        <p>MIT License</p>
      </footer>
    </main>
  );
}

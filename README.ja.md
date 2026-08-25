# pCloud MCP for Cloudflare Workers

[English](README.md) | **日本語**

pCloudに保存したファイルを、ChatGPTなどのMCP対応AIクライアントからCloudflare Workers経由で利用できるようにする、セルフホスト型・読み取り専用のRemote MCPサーバーです。

<sub>v0.1.0 — 初期リリースです。インターフェース、各種制限、セットアップ要件、クライアント互換性は変更される可能性があります。</sub>

## できること

- フォルダを一覧表示し、ファイル名・フォルダ名・仮想パスを検索する
- ファイルのメタデータと、対応するUTF-8テキストを読み取る
- PNG / JPEG画像やDOCX / XLSX / PPTXを対応するMCPクライアントへ返す
- `PCLOUD_ROOT_PATH` でMCPから参照可能なpCloudの範囲を特定のサブツリーに限定する

**非対応:** アップロード、削除、移動、名前変更、フォルダ作成、共有、ファイル本文の全文検索、PDF取得。

### 対応コンテンツ

| 種類 | 現在の対応 |
| --- | --- |
| テキスト | 対応形式のみ、UTF-8厳格。既定256 KiB、最大1 MiB |
| 画像 | PNG / JPEG、元ファイル最大5 MiB |
| Office | DOCX / XLSX / PPTX、元ファイル最大1 MiB |

大きなフォルダツリーでは検索上限に達する場合があります。その場合は検索範囲を狭めてください。途中までの不完全な検索結果は返しません。

<details>
<summary>現在のMCPツール</summary>

`hello`, `list_folder`, `search_files`, `get_file_info`, `read_file`, `get_image_content`, `get_office_content`

</details>

## 重要

> [!WARNING]
> **本ソフトウェアの利用は自己責任で行ってください。** 本ソフトウェアは現状有姿（**AS IS**）かつ無保証で提供され、バグ、セキュリティ上の脆弱性、誤った前提などを含む可能性があります。適用法令で認められる最大限の範囲において、作者および貢献者は、本ソフトウェアの利用または利用不能によって生じたデータ損失、情報漏えい、認証情報の侵害、サービス停止、アカウント上の問題、金銭的損失その他の損害について責任を負いません。
>
> **読み取り専用（read-only）は、非公開（private）という意味ではありません。** 認証されたMCPクライアントは、MCPから参照可能な範囲内のメタデータやファイル内容を受け取ることができます。`PCLOUD_ROOT_PATH` を使い、Cloudflare Accessで許可した利用者・MCPクライアントへ開示してよい内容だけをMCPから参照可能にしてください。

pCloudアクセストークンは漏えい時の影響が大きい認証情報として扱ってください。Gitへコミットしたり、Issue、スクリーンショット、ログ、AIチャットなどへ貼り付けたりしないでください。

<sub>本プロジェクトはAI支援コーディングを大きく利用して開発されています。テスト、レビュー、監査などは正確性や安全性を保証するものではありません。開発者は本ソフトウェアを通じてユーザーデータを収集しません。pCloud、Cloudflare、接続するMCPクライアントはそれぞれ別のサービスです。</sub>

完全な免責・責任制限は[AGPL-3.0-onlyライセンス](LICENSE)を、セキュリティモデルと脆弱性報告方法は[SECURITY.md](SECURITY.md)を確認してください。

## セットアップ

### AIに案内してもらう

このリポジトリをAIコーディングアシスタントへ渡し、既存のセットアップ文書に沿ってセルフホスト作業を案内させることができます。

```text
このリポジトリをセルフホストする作業を手伝ってください。
まず README.ja.md、docs/SETUP.md、SECURITY.md を読んでください。
英語版の表現や補足が必要な場合は README.md も参照してください。
文書に従って作業し、シークレットをチャットへ貼ったりGitへコミットしたりするよう求めないでください。
無関係な変更や破壊的な変更の前には停止してください。
```

### 自分でセットアップする

手動で行う場合は[docs/SETUP.md](docs/SETUP.md)に従ってください。

技術的なセットアップ・設計ドキュメントは現在英語のみで管理しています。

## ドキュメント

**利用者向け:** [Setup](docs/SETUP.md) · [Security](SECURITY.md)

**開発者向け:** [Design](docs/DESIGN.md) · [Development](docs/DEVELOPMENT.md) · [Agent instructions](AGENTS.md)

## ライセンスとプロジェクト情報

[GNU Affero General Public License v3.0 only](LICENSE) で提供します。

Developed by **YoraLAB**. 本プロジェクトは独立したオープンソースプロジェクトであり、pCloud、Cloudflare、OpenAIその他のMCPクライアント提供者による公式製品ではありません。

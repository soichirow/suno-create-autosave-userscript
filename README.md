# Suno Create Autosave (Tampermonkey Userscript)

Suno の作成画面 `https://suno.com/create` で入力する内容を、自動で保存・復元する Tampermonkey 用ユーザースクリプトです。

保存は URL の `wid`（workspace id）ごとに分かれます。
例:
- https://suno.com/create?wid=default
- https://suno.com/create?wid=<uuid>

## できること

- Lyrics / Style / Song Title を自動保存・自動復元
- wid（workspace id）ごとに保存先を分離
- Lyrics が空のままの場合、自動で `[Instrumental]` を挿入（通常時）
- Lyrics 用のボタン `TM Clear` を追加
  - 押すと Lyrics を空にして保存
  - その wid では「空のまま」を維持できる（次回リロードでも空のまま）

Song Title について
- 入力後にフォーカスを外したタイミング等で、末尾に `_YYMMDD` を付けて保存します
- 何度も実行しても日付が無限に増えないように、末尾の日付サフィックスは正規化します

## インストール

1. Tampermonkey をインストール（Chrome / Edge / Firefox）
2. 下のURLを開く（Tampermonkey のインストール画面が出ます）

https://raw.githubusercontent.com/soichirow/suno-create-autosave-userscript/main/Suno-Create-Autosave.user.js

3. Install を押して完了

## 使い方

- Suno の作成画面を開く: https://suno.com/create
- 入力すると自動で保存されます
- ページを再読み込みすると、直前に保存した内容が復元されます
- Lyrics を空にしたい場合は `TM Clear` を押してください
  - 手で全部消すだけだと、状況によっては `[Instrumental]` が再挿入されます（仕様）

## 保存の仕組み

- Tampermonkey のストレージ（GM_setValue / GM_getValue）に保存します
- wid ごとにキーが分かれます（同じPC・同じブラウザ・同じTampermonkey内で有効）

## 注意点

- 非公式スクリプトです。自己責任で利用してください
- Suno 側のUI変更で、セレクタが合わなくなると動かなくなる可能性があります
- 保存内容はクラウド同期されません
  - 別PCと共有したい場合は、Tampermonkey の同期機能や手動エクスポート等が必要です

## ライセンス

MIT

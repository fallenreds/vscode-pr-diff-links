# PR Diff Links

Расширение VS Code: клик по ссылке открывает **дифф файла из pull request в две колонки**. Слева база PR, справа PR, курсор на нужной строке. Это тот же встроенный дифф VS Code, что показывают Source Control и GitHub Pull Requests.

## Зачем

Когда ИИ-ассистент (Claude Code) или человек расписывает PR («функция `A` в файле `B` делает…»), читать проще, если каждая ссылка сразу открывает **изменения**, а не текущую версию файла.

Готовые варианты не подошли:

- **Чат Claude Code в VS Code** оставляет кликабельными только `http(s)`/`mailto` и обычные пути к файлам. Ссылки `vscode://…` и `file://…` он вырезает, поэтому deep-link'и других расширений (например, GitLens) из чата не открываются.
- **GitHub Pull Requests** открывает по ссылке только PR целиком, дифф отдельного файла на строке так не открыть.
- **Ссылки на github.com** уводят в браузер.

Поэтому ссылка здесь указывает на крошечный файл `*.prdiff`. Чат открывает его как обычный файл, а расширение тут же закрывает вкладку и показывает дифф.

## Как это работает

Файл `.prdiff` — это одна строка JSON:

```json
{"repo": "/abs/path/to/repo", "base": "<sha|ref>", "head": "<sha|ref>", "path": "src/app.py", "line": 42}
```

Что делает расширение:

1. берёт `merge-base base head`. Это то же, что показывает вкладка «Files changed» в PR (сравнение через три точки);
2. читает обе версии файла через `git show <ref>:<path>`. Встроенный Git API не нужен, поэтому работает любой репозиторий или worktree, даже если он не открыт в окне;
3. открывает `vscode.diff`. Если файл новый или удалён, вместо отсутствующей стороны показывает пустую.

Второй триггер — URI-обработчик для мест, где `vscode://` не вырезается (Markdown preview, браузер):

```
vscode://fallenreds.pr-diff-links/open?repo=…&base=…&head=…&path=…&line=…
```

Ошибки пишутся в Output → «PR Diff Links».

## Генератор ссылок

`bin/prdiff-link` печатает готовую Markdown-ссылку:

```bash
# по номеру PR (SHA берутся через gh, ссылки переживают мерж и удаление веток)
bin/prdiff-link --pr 82 --text "TeamMember" api/app/core/models.py 818
# → [TeamMember](/home/me/.cache/prdiff/repo/7b9cac8a8adf/api__app__core__models.py__L818.prdiff)

# то же место на GitHub, для описания PR
bin/prdiff-link --pr 82 --github --text "TeamMember" api/app/core/models.py 818
# → [TeamMember](https://github.com/<owner>/<repo>/pull/82/files#diff-<sha256(path)>R818)

# без PR, по явным ref'ам
bin/prdiff-link --refs origin/main HEAD src/app.py 42
```

Файлы `.prdiff` складываются в `~/.cache/prdiff/<repo>/<head>/`. Ответ `gh` кешируется только для смерженных и закрытых PR.

## Установка

```bash
npx @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension pr-diff-links-*.vsix
```

Нужны `git` и, для `--pr`, авторизованный [`gh`](https://cli.github.com/). Сборка не требуется: расширение на чистом JavaScript без зависимостей.

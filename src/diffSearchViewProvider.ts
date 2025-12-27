import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { GitDiffProvider, DiffLine } from "./gitDiffProvider";

export class DiffSearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "gitDiffSearch";
  private _view?: vscode.WebviewView;
  private _currentResults: DiffLine[] = [];
  private _l10n: any;
  private _activeFileFilter?: { file: string; changeType: string };
  private _pendingMessage?: any;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _gitDiffProvider: GitDiffProvider
  ) {
    // 初始化语言包
    this._initL10n();
  }

  public postMessage(message: any) {
    if (this._view) {
      this._view.webview.postMessage(message);
    } else {
      // 如果 Webview 还没加载（处于折叠状态），先存起来
      this._pendingMessage = message;
    }
  }

  private _initL10n() {
    const lang = vscode.env.language.toLowerCase();
    let nlsPath: string;

    // 这里的路径需要相对于编译后的文件位置
    // 编译后在 out/diffSearchViewProvider.js，package.nls.json 在根目录
    const rootPath = path.join(this._extensionUri.fsPath);

    if (lang === "zh-cn" || lang === "zh-tw") {
      nlsPath = path.join(rootPath, "package.nls.zh-cn.json");
    } else {
      nlsPath = path.join(rootPath, "package.nls.json");
    }

    let nls: any = {};
    try {
      if (fs.existsSync(nlsPath)) {
        const content = fs.readFileSync(nlsPath, "utf8");
        nls = JSON.parse(content);
      } else {
        // 回退到默认英文包
        const defaultPath = path.join(rootPath, "package.nls.json");
        if (fs.existsSync(defaultPath)) {
          nls = JSON.parse(fs.readFileSync(defaultPath, "utf8"));
        }
      }
    } catch (e) {
      console.error("Failed to load nls file:", e);
    }

    this._l10n = {
      placeholder: nls["webview.search.placeholder"] || "Search changes...",
      matchCase: nls["webview.matchCase.title"] || "Match Case",
      useRegex: nls["webview.useRegex.title"] || "Use Regular Expression",
      searchBtn: nls["webview.search.btn"] || "Search",
      noResults: nls["webview.noResults"] || "No results found",
      invalidRegex: nls["webview.invalidRegex"] || "Invalid regular expression",
      searchFailed: nls["webview.searchFailed"] || "Search failed",
      staged: nls["webview.staged"] || "STAGED",
      unstaged: nls["webview.unstaged"] || "UNSTAGED",
      untracked: nls["webview.untracked"] || "UNTRACKED",
    };

    // 如果是中文，保持之前要求的 STAGED/UNSTAGED 英文显示，或者根据需要调整
    // 用户之前说“统一使用英文”，所以这里保持 STAGED 等为英文
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this._extensionUri,
        vscode.Uri.joinPath(
          this._extensionUri,
          "node_modules",
          "@vscode/codicons",
          "dist"
        ),
      ],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // 如果有待处理的消息，等 Webview 加载完立即发送
    if (this._pendingMessage) {
      // 给 Webview 一点初始化脚本的时间
      setTimeout(() => {
        if (this._pendingMessage) {
          webviewView.webview.postMessage(this._pendingMessage);
          this._pendingMessage = undefined;
        }
      }, 500);
    }

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "search":
          this._activeFileFilter = data.fileFilter;
          this._view?.webview.postMessage({ type: "searching" }); // 通知 Webview 开始搜索
          await this._handleSearch(
            data.value,
            data.isRegex,
            data.isCaseSensitive,
            data.isWholeWord
          );
          break;
        case "openDiff":
          const result = this._currentResults[data.index];
          if (result) {
            await this._openDiff(
              result.file,
              result.lineNumber,
              result.changeType,
              result.type as "added" | "removed"
            );
          }
          break;
        case "clearFilter":
          this._activeFileFilter = undefined;
          break;
      }
    });
  }

  private async _handleSearch(
    query: string,
    isRegex: boolean,
    isCaseSensitive: boolean,
    isWholeWord: boolean
  ) {
    if (!query) {
      this._currentResults = [];
      this._view?.webview.postMessage({ type: "results", results: [] });
      return;
    }

    try {
      const allChanges = await this._gitDiffProvider.getParsedDiff();
      let results: DiffLine[] = [];

      // 基础过滤：排除 context 行，如果有关联文件则只搜当前文件
      let filteredChanges = allChanges.filter(
        (line) => line.type !== "context"
      );
      if (this._activeFileFilter) {
        filteredChanges = filteredChanges.filter(
          (line) =>
            line.file.toLowerCase() ===
              this._activeFileFilter!.file.toLowerCase() &&
            line.changeType === this._activeFileFilter!.changeType
        );
      }

      let regexSource = isRegex
        ? query
        : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (isWholeWord) {
        regexSource = `\\b${regexSource}\\b`;
      }

      try {
        const flags = isCaseSensitive ? "" : "i";
        const regex = new RegExp(regexSource, flags);
        results = filteredChanges.filter((line) => regex.test(line.content));
      } catch (e) {
        this._view?.webview.postMessage({
          type: "results",
          results: [],
          error: this._l10n.invalidRegex,
        });
        return;
      }

      this._currentResults = results;
      this._view?.webview.postMessage({ type: "results", results });
    } catch (error: any) {
      vscode.window.showErrorMessage(
        `${this._l10n.searchFailed}: ${error.message}`
      );
    }
  }

  private async _openDiff(
    filePath: string,
    lineNumber: number,
    changeType: "working" | "staged" | "untracked",
    lineType?: "added" | "removed"
  ) {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
      const fileName = filePath.split(/[\\/]/).pop();

      if (changeType === "untracked") {
        await this._openFile(fullPath, lineNumber);
        return;
      }

      let leftUri: vscode.Uri;
      let rightUri: vscode.Uri;
      let label: string;

      if (changeType === "staged") {
        leftUri = fullPath.with({
          scheme: "git",
          query: JSON.stringify({ path: fullPath.fsPath, ref: "HEAD" }),
        });
        rightUri = fullPath.with({
          scheme: "git",
          query: JSON.stringify({ path: fullPath.fsPath, ref: "~" }),
        });
        label = "Index";
      } else {
        leftUri = fullPath.with({
          scheme: "git",
          query: JSON.stringify({ path: fullPath.fsPath, ref: "~" }),
        });
        rightUri = fullPath;
        label = "Working Tree";
      }

      // 准备打开选项
      const options: vscode.TextDocumentShowOptions = {
        preview: true,
        preserveFocus: false, // 确保焦点离开 Webview 进入编辑器
      };

      // 关键：只有当是新增(added)时，才在打开时传 selection（因为 selection 默认作用于右侧）
      if (lineType !== "removed") {
        options.selection = new vscode.Range(
          lineNumber - 1,
          0,
          lineNumber - 1,
          0
        );
      }

      // 打开 Diff 视图
      await vscode.commands.executeCommand(
        "vscode.diff",
        leftUri,
        rightUri,
        `${fileName} (${label})`,
        options
      );

      // 针对"已删除"行的特殊处理（精准定位到左侧/红色区域）
      if (lineType === "removed") {
        let attempts = 0;
        const maxAttempts = 40; // 增加到 2秒左右，因为加载大文件 Diff 较慢

        const findAndFocusLeft = setInterval(async () => {
          attempts++;

          // 获取当前活动的编辑器组中的活动 Tab
          const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;

          if (activeTab && activeTab.input instanceof vscode.TabInputTextDiff) {
            const originalUri = activeTab.input.original;

            // 在可见编辑器中锁定左侧编辑器
            // 注意：有时候 toString 匹配会因为编码问题失效，增加 path 匹配作为兜底
            const leftEditor = vscode.window.visibleTextEditors.find(
              (e) =>
                e.document.uri.toString() === originalUri.toString() ||
                (e.document.uri.path === originalUri.path &&
                  e.document.uri.scheme === originalUri.scheme)
            );

            if (leftEditor) {
              clearInterval(findAndFocusLeft);

              const pos = new vscode.Position(lineNumber - 1, 0);

              // 1. 设置光标位置（Selection 的起始和结束点相同即为光标）
              leftEditor.selection = new vscode.Selection(pos, pos);

              // 2. 滚动到视野中心
              leftEditor.revealRange(
                new vscode.Range(pos, pos),
                vscode.TextEditorRevealType.InCenter
              );

              // 3. 【关键】强制切换焦点到左侧
              // 第一次尝试：立即切换
              await vscode.commands.executeCommand(
                "workbench.action.compareEditor.focusPrimarySide"
              );

              // 第二次尝试：延迟 100ms 再次切换
              // 因为 vscode.diff 打开后的内置聚焦逻辑可能会把焦点"抢"回右侧，
              // 这里的延迟执行可以确保在系统稳定后最终把焦点定在左侧。
              setTimeout(() => {
                vscode.commands.executeCommand(
                  "workbench.action.compareEditor.focusPrimarySide"
                );
              }, 100);
            }
          }

          if (attempts >= maxAttempts) {
            clearInterval(findAndFocusLeft);
          }
        }, 50);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Failed to open diff view: ${err.message}`
      );
    }
  }

  private async _openFile(uri: vscode.Uri, lineNumber: number) {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(lineNumber - 1, 0, lineNumber - 1, 0),
      preview: true,
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    // 关键修改：直接从本地 node_modules 加载，不依赖任何网络
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._extensionUri,
        "node_modules",
        "@vscode/codicons",
        "dist",
        "codicon.css"
      )
    );

    return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline';">
                <!-- 引入 VS Code 原生图标库 -->
                <link href="${codiconsUri}" rel="stylesheet" />
                <style>
                    body { padding: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
                    .search-container { padding: 10px; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--vscode-divider); flex-shrink: 0; }
                    
                    /* 模拟原生 Find Widget 的单行布局 */
                    .input-row { 
                        display: flex; 
                        align-items: center; 
                        background: var(--vscode-input-background); 
                        border: 1px solid var(--vscode-input-border); 
                        border-radius: 2px; 
                        padding: 1px;
                    }
                    .input-row:focus-within { border-color: var(--vscode-focusBorder); }
                    
                    input { 
                        flex: 1; 
                        border: none; 
                        background: transparent; 
                        color: var(--vscode-input-foreground); 
                        padding: 4px 6px; 
                        outline: none; 
                        font-size: 13px; 
                        min-width: 0;
                    }
                    
                    .controls { 
                        display: flex; 
                        gap: 1px; 
                        padding-right: 2px; 
                        align-items: center; 
                    }
                    .control { 
                        cursor: pointer; 
                        display: flex; 
                        align-items: center; 
                        justify-content: center; 
                        width: 22px; 
                        height: 22px; 
                        border-radius: 3px; 
                        font-size: 16px; 
                        color: var(--vscode-input-foreground);
                        opacity: 0.8;
                    }
                    /* 核心修复：专门针对方框内部的图标文字进行下移，而不动方框本身 */
                    .control.codicon::before {
                        transform: translateY(2px);
                    }
                    .control:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
                    .control.active { 
                        background: var(--vscode-inputOption-activeBackground); 
                        color: var(--vscode-inputOption-activeForeground); 
                        border: 1px solid var(--vscode-inputOption-activeBorder);
                        opacity: 1;
                    }

                    /* 导航按钮样式 */
                    .nav-controls {
                        display: flex;
                        gap: 2px;
                        padding-left: 4px;
                        margin-left: 4px;
                        border-left: 1px solid var(--vscode-divider);
                    }
                    
                    .result-item.selected {
                        background: var(--vscode-list-focusBackground);
                        color: var(--vscode-list-focusForeground);
                    }
                    
                    /* 文件过滤器标签 */
                    .filter-tag {
                        display: none;
                        align-items: center;
                        gap: 6px;
                        padding: 4px 8px;
                        background: var(--vscode-badge-background);
                        color: var(--vscode-badge-foreground);
                        border-radius: 4px;
                        font-size: 11px;
                        margin-top: 4px;
                    }
                    .filter-tag .close-filter { cursor: pointer; font-weight: bold; opacity: 0.7; }
                    .filter-tag .close-filter:hover { opacity: 1; }

                    .results { flex: 1; overflow-y: auto; }
                    .result-item { padding: 6px 10px; cursor: pointer; border-bottom: 1px solid var(--vscode-divider); transition: background 0.1s; }
                    .result-item:hover { background: var(--vscode-list-hoverBackground); }
                    .file-info { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
                    .file-name { color: var(--vscode-textLink-foreground); font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
                    .line-num { color: var(--vscode-descriptionForeground); font-size: 11px; }
                    .change-tag { font-size: 9px; padding: 1px 4px; border-radius: 2px; margin-left: 6px; font-weight: bold; }
                    .tag-staged { background: #007acc; color: white; }
                    .tag-working { background: #e2c522; color: black; }
                    .tag-untracked { background: #4ec9b0; color: black; }
                    
                    .line-content { 
                        font-family: var(--vscode-editor-font-family); 
                        font-size: 12px; 
                        white-space: pre; 
                        overflow: hidden; 
                        text-overflow: ellipsis; 
                        padding: 2px 6px; 
                        background: var(--vscode-editor-background);
                        border-radius: 2px;
                        border-left: 3px solid transparent;
                    }
                    .line-content.added { border-left-color: #4ec9b0; }
                    .line-content.removed { border-left-color: #f48771; }
                    .no-results { padding: 40px 20px; text-align: center; color: var(--vscode-descriptionForeground); }
                    .error-msg { padding: 10px; color: var(--vscode-errorForeground); background: rgba(255,0,0,0.1); font-size: 12px; margin: 10px; border-radius: 4px; }
                </style>
            </head>
            <body>
                <div class="search-container">
                    <div class="input-row">
                        <input type="text" id="searchInput" placeholder="${this._l10n.placeholder}" spellcheck="false">
                        <div class="controls">
                            <div id="caseSensitive" class="control codicon codicon-case-sensitive" title="${this._l10n.matchCase}"></div>
                            <div id="wholeWord" class="control codicon codicon-whole-word" title="Match Whole Word"></div>
                            <div id="regex" class="control codicon codicon-regex" title="${this._l10n.useRegex}"></div>
                        </div>
                        <div class="nav-controls">
                            <div id="prevMatch" class="control codicon codicon-arrow-up" title="Previous Match"></div>
                            <div id="nextMatch" class="control codicon codicon-arrow-down" title="Next Match"></div>
                        </div>
                    </div>
                    <div id="filterTag" class="filter-tag">
                        <span>Current File Mode</span>
                        <span id="filterFileName" style="opacity: 0.8; font-style: italic;"></span>
                        <span class="close-filter" id="clearFilter">×</span>
                    </div>
                </div>
                <div id="error" class="error-msg" style="display: none;"></div>
                <div id="results" class="results"></div>

                <script>
                    const vscode = acquireVsCodeApi();
                    let isRegex = false;
                    let isCaseSensitive = false;
                    let isWholeWord = false;
                    let activeFileFilter = null;
                    let selectedIndex = -1;
                    let currentResultsCount = 0;
                    let searchTimeout;

                    const searchInput = document.getElementById('searchInput');
                    const resultsContainer = document.getElementById('results');
                    const errorContainer = document.getElementById('error');
                    const regexToggle = document.getElementById('regex');
                    const caseToggle = document.getElementById('caseSensitive');
                    const wordToggle = document.getElementById('wholeWord');
                    const prevBtn = document.getElementById('prevMatch');
                    const nextBtn = document.getElementById('nextMatch');
                    const filterTag = document.getElementById('filterTag');
                    const filterFileName = document.getElementById('filterFileName');
                    const clearFilterBtn = document.getElementById('clearFilter');

                    function triggerSearch(immediate = false) {
                        clearTimeout(searchTimeout);
                        if (immediate) {
                            performSearch();
                        } else {
                            searchTimeout = setTimeout(performSearch, 300); // 防抖处理
                        }
                    }

                    function performSearch() {
                        errorContainer.style.display = 'none';
                        selectedIndex = -1; // 重置选中项
                        vscode.postMessage({
                            type: 'search',
                            value: searchInput.value,
                            isRegex,
                            isCaseSensitive,
                            isWholeWord,
                            fileFilter: activeFileFilter
                        });
                    }

                    function updateSelection(newIndex) {
                        if (currentResultsCount === 0) return;
                        
                        // 移除之前的选中状态
                        const items = resultsContainer.querySelectorAll('.result-item');
                        if (selectedIndex >= 0 && selectedIndex < items.length) {
                            items[selectedIndex].classList.remove('selected');
                        }

                        // 循环选择
                        selectedIndex = (newIndex + currentResultsCount) % currentResultsCount;
                        
                        // 添加新的选中状态并滚动到视图中
                        const newSelectedItem = items[selectedIndex];
                        if (newSelectedItem) {
                            newSelectedItem.classList.add('selected');
                            newSelectedItem.scrollIntoView({ block: 'nearest' });
                            // 自动打开对应的 Diff
                            openDiff(selectedIndex);
                        }
                    }

                    prevBtn.onclick = () => updateSelection(selectedIndex - 1);
                    nextBtn.onclick = () => updateSelection(selectedIndex + 1);

                    regexToggle.onclick = () => {
                        isRegex = !isRegex;
                        regexToggle.classList.toggle('active', isRegex);
                        triggerSearch(true);
                    };

                    caseToggle.onclick = () => {
                        isCaseSensitive = !isCaseSensitive;
                        caseToggle.classList.toggle('active', isCaseSensitive);
                        triggerSearch(true);
                    };

                    wordToggle.onclick = () => {
                        isWholeWord = !isWholeWord;
                        wordToggle.classList.toggle('active', isWholeWord);
                        triggerSearch(true);
                    };

                    clearFilterBtn.onclick = () => {
                        activeFileFilter = null;
                        filterTag.style.display = 'none';
                        vscode.postMessage({ type: 'clearFilter' });
                        triggerSearch(true);
                    };

                    searchInput.oninput = () => {
                        triggerSearch();
                    };

                    searchInput.onkeydown = (e) => {
                        if (e.key === 'Enter') {
                            triggerSearch(true);
                        }
                    };

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'filterByFile') {
                            activeFileFilter = message.data;
                            filterFileName.textContent = message.data.file;
                            filterTag.style.display = 'flex';
                            searchInput.focus();
                            triggerSearch(true);
                        } else if (message.type === 'results') {
                            if (message.error) {
                                errorContainer.textContent = message.error;
                                errorContainer.style.display = 'block';
                                resultsContainer.innerHTML = '';
                                currentResultsCount = 0;
                            } else {
                                currentResultsCount = message.results.length;
                                renderResults(message.results);
                            }
                        }
                    });

                    function renderResults(results) {
                        if (results.length === 0) {
                            resultsContainer.innerHTML = '<div class="no-results">${this._l10n.noResults}</div>';
                            return;
                        }
                        
                        const typeLabels = {
                            'staged': '${this._l10n.staged}',
                            'working': '${this._l10n.unstaged}',
                            'untracked': '${this._l10n.untracked}'
                        };

                        resultsContainer.innerHTML = results.map((r, index) => {
                            const isSelected = index === selectedIndex ? 'selected' : '';
                            return '<div class="result-item ' + isSelected + '" onclick="openDiff(' + index + ')">' +
                                '<div class="file-info">' +
                                    '<div style="display: flex; align-items: center; overflow: hidden;">' +
                                        '<span class="file-name" title="' + r.file + '">' + r.file + '</span>' +
                                        '<span class="change-tag tag-' + r.changeType + '">' + typeLabels[r.changeType] + '</span>' +
                                    '</div>' +
                                    '<span class="line-num">L' + r.lineNumber + '</span>' +
                                '</div>' +
                                '<div class="line-content ' + r.type + '">' + escapeHtml(r.content) + '</div>' +
                            '</div>';
                        }).join('');
                    }

                    function openDiff(index) {
                        selectedIndex = index;
                        // 更新列表中的选中状态
                        const items = resultsContainer.querySelectorAll('.result-item');
                        items.forEach((item, i) => {
                            item.classList.toggle('selected', i === index);
                        });
                        vscode.postMessage({ type: 'openDiff', index });
                    }

                    function escapeHtml(text) {
                        const div = document.createElement('div');
                        div.textContent = text;
                        return div.innerHTML;
                    }
                </script>
            </body>
            </html>`;
  }
}

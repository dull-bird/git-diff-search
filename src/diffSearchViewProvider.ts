import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitDiffProvider, DiffLine } from './gitDiffProvider';

export class DiffSearchViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'gitDiffSearch';
    private _view?: vscode.WebviewView;
    private _currentResults: DiffLine[] = [];
    private _l10n: any;
    private _activeFileFilter?: { file: string, changeType: string };

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _gitDiffProvider: GitDiffProvider
    ) {
        // 初始化语言包
        this._initL10n();
    }

    public postMessage(message: any) {
        this._view?.webview.postMessage(message);
    }

    private _initL10n() {
        const lang = vscode.env.language.toLowerCase();
        let nlsPath: string;
        
        // 这里的路径需要相对于编译后的文件位置
        // 编译后在 out/diffSearchViewProvider.js，package.nls.json 在根目录
        const rootPath = path.join(this._extensionUri.fsPath);
        
        if (lang === 'zh-cn' || lang === 'zh-tw') {
            nlsPath = path.join(rootPath, 'package.nls.zh-cn.json');
        } else {
            nlsPath = path.join(rootPath, 'package.nls.json');
        }

        let nls: any = {};
        try {
            if (fs.existsSync(nlsPath)) {
                const content = fs.readFileSync(nlsPath, 'utf8');
                nls = JSON.parse(content);
            } else {
                // 回退到默认英文包
                const defaultPath = path.join(rootPath, 'package.nls.json');
                if (fs.existsSync(defaultPath)) {
                    nls = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
                }
            }
        } catch (e) {
            console.error('Failed to load nls file:', e);
        }

        this._l10n = {
            placeholder: nls['webview.search.placeholder'] || "Search changes...",
            matchCase: nls['webview.matchCase.title'] || "Match Case",
            useRegex: nls['webview.useRegex.title'] || "Use Regular Expression",
            searchBtn: nls['webview.search.btn'] || "Search",
            noResults: nls['webview.noResults'] || "No results found",
            invalidRegex: nls['webview.invalidRegex'] || "Invalid regular expression",
            searchFailed: nls['webview.searchFailed'] || "Search failed",
            staged: nls['webview.staged'] || "STAGED",
            unstaged: nls['webview.unstaged'] || "UNSTAGED",
            untracked: nls['webview.untracked'] || "UNTRACKED"
        };
        
        // 如果是中文，保持之前要求的 STAGED/UNSTAGED 英文显示，或者根据需要调整
        // 用户之前说“统一使用英文”，所以这里保持 STAGED 等为英文
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'search':
                    this._activeFileFilter = data.fileFilter;
                    this._view?.webview.postMessage({ type: 'searching' }); // 通知 Webview 开始搜索
                    await this._handleSearch(data.value, data.isRegex, data.isCaseSensitive, data.isWholeWord);
                    break;
                case 'openDiff':
                    const result = this._currentResults[data.index];
                    if (result) {
                        await this._openDiff(result.file, result.lineNumber, result.changeType);
                    }
                    break;
                case 'clearFilter':
                    this._activeFileFilter = undefined;
                    break;
            }
        });
    }

    private async _handleSearch(query: string, isRegex: boolean, isCaseSensitive: boolean, isWholeWord: boolean) {
        if (!query) {
            this._currentResults = [];
            this._view?.webview.postMessage({ type: 'results', results: [] });
            return;
        }

        try {
            const allChanges = await this._gitDiffProvider.getParsedDiff();
            let results: DiffLine[] = [];
            
            // 基础过滤：排除 context 行，如果有关联文件则只搜当前文件
            let filteredChanges = allChanges.filter(line => line.type !== 'context');
            if (this._activeFileFilter) {
                filteredChanges = filteredChanges.filter(line => 
                    line.file.toLowerCase() === this._activeFileFilter!.file.toLowerCase() &&
                    line.changeType === this._activeFileFilter!.changeType
                );
            }

            let regexSource = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (isWholeWord) {
                regexSource = `\\b${regexSource}\\b`;
            }

            try {
                const flags = isCaseSensitive ? '' : 'i';
                const regex = new RegExp(regexSource, flags);
                results = filteredChanges.filter(line => regex.test(line.content));
            } catch (e) {
                this._view?.webview.postMessage({ type: 'results', results: [], error: this._l10n.invalidRegex });
                return;
            }

            this._currentResults = results;
            this._view?.webview.postMessage({ type: 'results', results });
        } catch (error: any) {
            vscode.window.showErrorMessage(`${this._l10n.searchFailed}: ${error.message}`);
        }
    }

    private async _openDiff(filePath: string, lineNumber: number, changeType: 'working' | 'staged' | 'untracked') {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) return;

            const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
            const fileName = filePath.split(/[\\/]/).pop();

            if (changeType === 'untracked') {
                await this._openFile(fullPath, lineNumber);
                return;
            }

            const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
            if (!gitExtension) {
                await this._openFile(fullPath, lineNumber);
                return;
            }

            let leftUri: vscode.Uri;
            let rightUri: vscode.Uri;
            let label: string;

            if (changeType === 'staged') {
                leftUri = fullPath.with({ 
                    scheme: 'git', 
                    query: JSON.stringify({ path: fullPath.fsPath, ref: 'HEAD' }) 
                });
                rightUri = fullPath.with({ 
                    scheme: 'git', 
                    query: JSON.stringify({ path: fullPath.fsPath, ref: '~' }) 
                });
                label = 'Index';
            } else {
                leftUri = fullPath.with({ 
                    scheme: 'git', 
                    query: JSON.stringify({ path: fullPath.fsPath, ref: '~' }) 
                });
                rightUri = fullPath;
                label = 'Working Tree';
            }

            await vscode.commands.executeCommand('vscode.diff', 
                leftUri, 
                rightUri, 
                `${fileName} (${label})`,
                {
                    selection: new vscode.Range(lineNumber - 1, 0, lineNumber - 1, 0),
                    preview: true
                }
            );
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to open diff view: ${err.message}`);
        }
    }

    private async _openFile(uri: vscode.Uri, lineNumber: number) {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
            selection: new vscode.Range(lineNumber - 1, 0, lineNumber - 1, 0),
            preview: true
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
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
                    
                    .controls { display: flex; gap: 1px; padding-right: 2px; align-items: center; }
                    .control { 
                        cursor: pointer; 
                        display: flex; 
                        align-items: center; 
                        justify-content: center; 
                        width: 22px; 
                        height: 22px; 
                        border-radius: 3px; 
                        font-size: 12px;
                        color: var(--vscode-input-foreground);
                        opacity: 0.8;
                    }
                    .control:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
                    .control.active { 
                        background: var(--vscode-inputOption-activeBackground); 
                        color: var(--vscode-inputOption-activeForeground); 
                        border: 1px solid var(--vscode-inputOption-activeBorder);
                        opacity: 1;
                    }
                    
                    /* 加载动画 */
                    .loading-spinner {
                        display: none;
                        width: 14px;
                        height: 14px;
                        border: 2px solid var(--vscode-textLink-foreground);
                        border-top: 2px solid transparent;
                        border-radius: 50%;
                        animation: spin 1s linear infinite;
                        margin-right: 4px;
                    }
                    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

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
                        <div id="loader" class="loading-spinner"></div>
                        <div class="controls">
                            <div id="caseSensitive" class="control" title="${this._l10n.matchCase}">Aa</div>
                            <div id="wholeWord" class="control" title="Match Whole Word">ab</div>
                            <div id="regex" class="control" title="${this._l10n.useRegex}">.*</div>
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

                    const searchInput = document.getElementById('searchInput');
                    const loader = document.getElementById('loader');
                    const resultsContainer = document.getElementById('results');
                    const errorContainer = document.getElementById('error');
                    const regexToggle = document.getElementById('regex');
                    const caseToggle = document.getElementById('caseSensitive');
                    const wordToggle = document.getElementById('wholeWord');
                    const filterTag = document.getElementById('filterTag');
                    const filterFileName = document.getElementById('filterFileName');
                    const clearFilterBtn = document.getElementById('clearFilter');

                    let searchTimeout;
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
                        loader.style.display = 'block'; // 显示加载动画
                        vscode.postMessage({
                            type: 'search',
                            value: searchInput.value,
                            isRegex,
                            isCaseSensitive,
                            isWholeWord,
                            fileFilter: activeFileFilter
                        });
                    }

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

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'filterByFile') {
                            activeFileFilter = message.data;
                            filterFileName.textContent = message.data.file;
                            filterTag.style.display = 'flex';
                            searchInput.focus();
                            triggerSearch(true);
                        } else if (message.type === 'searching') {
                            loader.style.display = 'block';
                        } else if (message.type === 'results') {
                            loader.style.display = 'none'; // 隐藏加载动画
                            if (message.error) {
                                errorContainer.textContent = message.error;
                                errorContainer.style.display = 'block';
                                resultsContainer.innerHTML = '';
                            } else {
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

                        resultsContainer.innerHTML = results.map((r, index) => \`
                            <div class="result-item" onclick="openDiff(\${index})">
                                <div class="file-info">
                                    <div style="display: flex; align-items: center; overflow: hidden;">
                                        <span class="file-name" title="\${r.file}">\${r.file}</span>
                                        <span class="change-tag tag-\${r.changeType}">\${typeLabels[r.changeType]}</span>
                                    </div>
                                    <span class="line-num">L\${r.lineNumber}</span>
                                </div>
                                <div class="line-content \${r.type}">\${escapeHtml(r.content)}</div>
                            </div>
                        \`).join('');
                    }

                    function openDiff(index) {
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

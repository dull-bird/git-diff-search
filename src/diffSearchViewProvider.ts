import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitDiffProvider, DiffLine } from './gitDiffProvider';

export class DiffSearchViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'gitDiffSearch';
    private _view?: vscode.WebviewView;
    private _currentResults: DiffLine[] = [];
    private _l10n: any;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _gitDiffProvider: GitDiffProvider
    ) {
        // 初始化语言包
        this._initL10n();
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
                    await this._handleSearch(data.value, data.isRegex, data.isCaseSensitive);
                    break;
                case 'openDiff':
                    const result = this._currentResults[data.index];
                    if (result) {
                        await this._openDiff(result.file, result.lineNumber, result.changeType);
                    }
                    break;
            }
        });
    }

    private async _handleSearch(query: string, isRegex: boolean, isCaseSensitive: boolean) {
        if (!query) {
            this._currentResults = [];
            this._view?.webview.postMessage({ type: 'results', results: [] });
            return;
        }

        try {
            const allChanges = await this._gitDiffProvider.getParsedDiff();
            let results: DiffLine[] = [];
            
            if (isRegex) {
                try {
                    const flags = isCaseSensitive ? 'g' : 'gi';
                    const regex = new RegExp(query, flags);
                    results = allChanges.filter(line => line.type !== 'context' && regex.test(line.content));
                } catch (e) {
                    this._view?.webview.postMessage({ type: 'results', results: [], error: this._l10n.invalidRegex });
                    return;
                }
            } else {
                const q = isCaseSensitive ? query : query.toLowerCase();
                results = allChanges.filter(line => {
                    if (line.type === 'context') return false;
                    const content = isCaseSensitive ? line.content : line.content.toLowerCase();
                    return content.includes(q);
                });
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
                    body { padding: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; }
                    .search-container { padding: 8px; display: flex; flex-direction: column; gap: 4px; border-bottom: 1px solid var(--vscode-divider); }
                    .input-row { display: flex; align-items: center; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 2px; }
                    .input-row:focus-within { border-color: var(--vscode-focusBorder); }
                    input { flex: 1; border: none; background: transparent; color: var(--vscode-input-foreground); padding: 3px 6px; outline: none; font-size: 13px; }
                    .controls { display: flex; gap: 2px; padding-right: 2px; }
                    .control { cursor: pointer; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 3px; font-size: 12px; }
                    .control.active { background: var(--vscode-inputOption-activeBackground); color: var(--vscode-inputOption-activeForeground); border: 1px solid var(--vscode-inputOption-activeBorder); }
                    .control:not(.active):hover { background: var(--vscode-toolbar-hoverBackground); }
                    .results { overflow-y: auto; }
                    .result-item { padding: 4px 8px; cursor: pointer; display: flex; flex-direction: column; }
                    .result-item:hover { background: var(--vscode-list-hoverBackground); }
                    .file-info { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; }
                    .file-name { color: var(--vscode-textLink-foreground); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                    .line-num { color: var(--vscode-descriptionForeground); font-size: 11px; }
                    .change-tag { font-size: 9px; padding: 1px 4px; border-radius: 2px; margin-left: 4px; text-transform: uppercase; }
                    .tag-staged { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
                    .tag-working { background: rgba(255, 191, 0, 0.2); color: #ffbf00; border: 1px solid rgba(255, 191, 0, 0.3); }
                    .tag-untracked { background: rgba(78, 201, 176, 0.2); color: #4ec9b0; border: 1px solid rgba(78, 201, 176, 0.3); }
                    .line-content { font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre; overflow: hidden; text-overflow: ellipsis; padding-left: 4px; border-left: 2px solid transparent; }
                    .line-content.added { border-left-color: #4ec9b0; }
                    .line-content.removed { border-left-color: #f48771; }
                    .no-results { padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); }
                    .error-msg { padding: 8px; color: var(--vscode-errorForeground); font-size: 12px; }
                </style>
            </head>
            <body>
                <div class="search-container">
                    <div class="input-row">
                        <input type="text" id="searchInput" placeholder="${this._l10n.placeholder}" spellcheck="false">
                        <div class="controls">
                            <div id="caseSensitive" class="control" title="${this._l10n.matchCase}">Aa</div>
                            <div id="regex" class="control" title="${this._l10n.useRegex}">.*</div>
                            <div id="searchBtn" class="control" title="${this._l10n.searchBtn}" style="color: var(--vscode-textLink-foreground); font-weight: bold;">↵</div>
                        </div>
                    </div>
                </div>
                <div id="error" class="error-msg" style="display: none;"></div>
                <div id="results" class="results"></div>

                <script>
                    const vscode = acquireVsCodeApi();
                    let isRegex = false;
                    let isCaseSensitive = false;

                    const searchInput = document.getElementById('searchInput');
                    const searchBtn = document.getElementById('searchBtn');
                    const resultsContainer = document.getElementById('results');
                    const errorContainer = document.getElementById('error');
                    const regexToggle = document.getElementById('regex');
                    const caseToggle = document.getElementById('caseSensitive');

                    function triggerSearch() {
                        errorContainer.style.display = 'none';
                        vscode.postMessage({
                            type: 'search',
                            value: searchInput.value,
                            isRegex,
                            isCaseSensitive
                        });
                    }

                    regexToggle.onclick = () => {
                        isRegex = !isRegex;
                        regexToggle.classList.toggle('active', isRegex);
                    };

                    caseToggle.onclick = () => {
                        isCaseSensitive = !isCaseSensitive;
                        caseToggle.classList.toggle('active', isCaseSensitive);
                    };

                    searchBtn.onclick = triggerSearch;

                    searchInput.onkeydown = (e) => {
                        if (e.key === 'Enter') {
                            triggerSearch();
                        }
                    };

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'results') {
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

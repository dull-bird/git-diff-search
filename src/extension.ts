import * as vscode from 'vscode';
import * as path from 'path';
import { GitDiffProvider } from './gitDiffProvider';
import { DiffSearchViewProvider } from './diffSearchViewProvider';

export function activate(context: vscode.ExtensionContext) {
    const gitDiffProvider = new GitDiffProvider();
    
    const provider = new DiffSearchViewProvider(context.extensionUri, gitDiffProvider);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            DiffSearchViewProvider.viewType,
            provider
        )
    );

    // 聚焦命令
    const focusCommand = vscode.commands.registerCommand('gitDiffSearch.focus', async () => {
        await vscode.commands.executeCommand('workbench.view.scm');
    });

    // 搜索当前激活的 Diff 命令
    const searchInActiveDiffCommand = vscode.commands.registerCommand('gitDiffSearch.searchInActiveDiff', async () => {
        const editor = vscode.window.activeTextEditor;
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        
        if (!editor || !tab || !(tab.input instanceof vscode.TabInputTextDiff)) {
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }
        
        const input = tab.input as vscode.TabInputTextDiff;
        let filePath = input.modified.fsPath;
        let activeChangeType: 'working' | 'staged' | 'untracked' = 'working';

        // 识别当前 Diff 视图的类型 (根据右侧 modified URI 判断)
        if (input.modified.scheme === 'git') {
            try {
                const query = JSON.parse(input.modified.query);
                filePath = query.path || filePath;
                // Index 视图：右侧 ref 为 ~
                activeChangeType = 'staged';
            } catch (e) {
                activeChangeType = 'staged';
            }
        } else if (input.modified.scheme === 'file') {
            // Working Tree 视图：右侧是本地文件
            activeChangeType = 'working';
        }
        
        const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath).replace(/\\/g, '/');

        // 弹出输入框获取搜索词
        const queryTerm = await vscode.window.showInputBox({
            placeHolder: vscode.l10n ? vscode.l10n.t('webview.search.placeholder') : 'Search changes...',
            prompt: `Searching in ${activeChangeType === 'staged' ? 'INDEX (STAGED)' : 'WORKING TREE (UNSTAGED)'} changes`
        });

        if (!queryTerm) { return; }

        try {
            const allChanges = await gitDiffProvider.getParsedDiff();
            
            // 精准过滤
            const fileChanges = allChanges.filter(c => {
                const isSameFile = c.file.toLowerCase() === relativePath.toLowerCase();
                const isCorrectType = c.changeType === activeChangeType;
                const isNotContext = c.type !== 'context';
                const matchesQuery = c.content.toLowerCase().includes(queryTerm.toLowerCase());
                return isSameFile && isCorrectType && isNotContext && matchesQuery;
            });

            if (fileChanges.length === 0) {
                const viewName = activeChangeType === 'staged' ? 'INDEX' : 'WORKING TREE';
                vscode.window.showInformationMessage(`No matches found in ${viewName} for "${queryTerm}"`);
                return;
            }

            // 弹出 QuickPick
            const items = fileChanges.map(c => ({
                label: `Line ${c.lineNumber}: ${c.content.trim()}`,
                description: c.type === 'added' ? 'ADDED' : 'REMOVED',
                change: c
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: `Found ${fileChanges.length} matches in current ${activeChangeType === 'staged' ? 'Index' : 'Working Tree'} view`
            });

            if (selected) {
                const line = Math.max(0, selected.change.lineNumber - 1);
                const range = new vscode.Range(line, 0, line, 0);
                editor.selection = new vscode.Selection(range.start, range.end);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Search failed: ${error.message}`);
        }
    });

    context.subscriptions.push(focusCommand, searchInActiveDiffCommand);
}

export function deactivate() {}


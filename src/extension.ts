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
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (!tab || !(tab.input instanceof vscode.TabInputTextDiff)) {
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }
        
        const input = tab.input as vscode.TabInputTextDiff;
        let filePath = input.modified.fsPath;
        let activeChangeType: 'working' | 'staged' = 'working';

        if (input.modified.scheme === 'git') {
            try {
                const query = JSON.parse(input.modified.query);
                filePath = query.path || filePath;
                activeChangeType = 'staged';
            } catch (e) {
                activeChangeType = 'staged';
            }
        }

        const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath).replace(/\\/g, '/');

        // 1. 强制打开侧边栏
        await vscode.commands.executeCommand('gitDiffSearch.focus');
        
        // 2. 通知 Webview 进入“当前文件模式”
        provider.postMessage({
            command: 'filterByFile',
            data: {
                file: relativePath,
                changeType: activeChangeType
            }
        });
    });

    context.subscriptions.push(focusCommand, searchInActiveDiffCommand);
}

export function deactivate() {}

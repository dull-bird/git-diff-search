import * as vscode from 'vscode';
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

    context.subscriptions.push(focusCommand);
}

export function deactivate() {}


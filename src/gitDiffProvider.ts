import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

export interface DiffLine {
    file: string;
    lineNumber: number;
    content: string;
    type: 'added' | 'removed' | 'context';
    changeType: 'working' | 'staged' | 'untracked';
}

export class GitDiffProvider {
    private workspaceFolder: vscode.WorkspaceFolder | undefined;

    constructor() {
        this.workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    }

    /**
     * 获取所有未提交的修改内容（包括工作区、暂存区和未跟踪文件）
     */
    async getAllUncommittedChanges(): Promise<string> {
        if (!this.workspaceFolder) {
            throw new Error('没有打开的工作区');
        }

        const parts: string[] = [];

        try {
            // 1. 获取工作区的修改（相对于暂存区）
            const workingDiff = await this.getWorkingDirectoryDiff();
            if (workingDiff) {
                parts.push('=== 工作区修改（未暂存）===\n');
                parts.push(workingDiff);
                parts.push('\n');
            }

            // 2. 获取暂存区的修改（相对于HEAD）
            const stagedDiff = await this.getStagedDiff();
            if (stagedDiff) {
                parts.push('=== 暂存区修改（已暂存）===\n');
                parts.push(stagedDiff);
                parts.push('\n');
            }

            // 3. 获取未跟踪的文件内容
            const untrackedFiles = await this.getUntrackedFilesContent();
            if (untrackedFiles) {
                parts.push('=== 未跟踪的文件 ===\n');
                parts.push(untrackedFiles);
            }

            return parts.join('\n');
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                throw new Error('Git未安装或不在PATH中');
            }
            throw error;
        }
    }

    /**
     * 获取工作区的diff内容（相对于暂存区）
     */
    private async getWorkingDirectoryDiff(): Promise<string> {
        if (!this.workspaceFolder) {
            return '';
        }

        try {
            const { stdout, stderr } = await execAsync('git diff', {
                cwd: this.workspaceFolder.uri.fsPath,
                encoding: 'utf8'
            });

            if (stderr && !stderr.includes('warning')) {
                console.warn('git diff stderr:', stderr);
            }

            return stdout || '';
        } catch (error: any) {
            // 如果没有修改，git diff可能返回非零退出码，这是正常的
            return '';
        }
    }

    /**
     * 获取暂存区的diff内容（相对于HEAD）
     */
    private async getStagedDiff(): Promise<string> {
        if (!this.workspaceFolder) {
            return '';
        }

        try {
            const { stdout, stderr } = await execAsync('git diff --cached', {
                cwd: this.workspaceFolder.uri.fsPath,
                encoding: 'utf8'
            });

            if (stderr && !stderr.includes('warning')) {
                console.warn('git diff --cached stderr:', stderr);
            }

            return stdout || '';
        } catch (error: any) {
            // 如果没有暂存的修改，这是正常的
            return '';
        }
    }

    /**
     * 获取未跟踪文件的内容
     */
    private async getUntrackedFilesContent(): Promise<string> {
        if (!this.workspaceFolder) {
            return '';
        }

        try {
            // 获取未跟踪的文件列表
            const { stdout: filesOutput } = await execAsync('git ls-files --others --exclude-standard', {
                cwd: this.workspaceFolder.uri.fsPath,
                encoding: 'utf8'
            });

            const untrackedFiles = filesOutput.trim().split('\n').filter(f => f.trim());
            
            if (untrackedFiles.length === 0) {
                return '';
            }

            const parts: string[] = [];

            for (const file of untrackedFiles) {
                try {
                    const filePath = path.join(this.workspaceFolder.uri.fsPath, file);
                    
                    // 检查文件是否存在且是文本文件
                    if (fs.existsSync(filePath)) {
                        const stats = fs.statSync(filePath);
                        // 只读取小于1MB的文件
                        if (stats.isFile() && stats.size < 1024 * 1024) {
                            const content = fs.readFileSync(filePath, 'utf8');
                            parts.push(`diff --git a/dev/null b/${file}`);
                            parts.push(`new file mode 100644`);
                            parts.push(`index 0000000..${this.getFileHash(content)}`);
                            parts.push(`--- /dev/null`);
                            parts.push(`+++ b/${file}`);
                            
                            // 将文件内容格式化为diff格式（所有行都是新增的）
                            const lines = content.split('\n');
                            if (lines.length > 0) {
                                parts.push(`@@ -0,0 +1,${lines.length} @@`);
                                for (const line of lines) {
                                    parts.push(`+${line}`);
                                }
                            }
                            parts.push('');
                        }
                    }
                } catch (fileError: any) {
                    // 忽略无法读取的文件（可能是二进制文件等）
                    console.warn(`无法读取文件 ${file}:`, fileError.message);
                }
            }

            return parts.join('\n');
        } catch (error: any) {
            // 如果没有未跟踪的文件，这是正常的
            return '';
        }
    }

    /**
     * 简单的文件哈希（用于diff显示）
     */
    private getFileHash(content: string): string {
        // 简单的哈希，实际git使用SHA1，这里简化处理
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 转换为32位整数
        }
        return Math.abs(hash).toString(16).substring(0, 7);
    }

    /**
     * 获取未提交的diff内容（保持向后兼容）
     * @deprecated 使用 getAllUncommittedChanges 代替
     */
    async getUncommittedDiff(): Promise<string> {
        return this.getAllUncommittedChanges();
    }

    /**
     * 获取所有未提交的修改，并解析为结构化数据
     */
    async getParsedDiff(): Promise<DiffLine[]> {
        const diffContent = await this.getAllUncommittedChanges();
        return this.parseDiff(diffContent);
    }

    /**
     * 解析diff内容为结构化数据
     */
    parseDiff(diffContent: string): DiffLine[] {
        const lines: DiffLine[] = [];
        const diffLines = diffContent.split('\n');
        let currentFile = '';
        let oldLineNumber = 0;
        let newLineNumber = 0;
        let currentChangeType: 'working' | 'staged' | 'untracked' = 'working';

        for (const line of diffLines) {
            // 检测区块头
            if (line.startsWith('=== 工作区修改（未暂存）===')) {
                currentChangeType = 'working';
                continue;
            } else if (line.startsWith('=== 暂存区修改（已暂存）===')) {
                currentChangeType = 'staged';
                continue;
            } else if (line.startsWith('=== 未跟踪的文件 ===')) {
                currentChangeType = 'untracked';
                continue;
            }

            // 文件路径行: diff --git a/file b/file
            if (line.startsWith('diff --git')) {
                const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
                if (match) {
                    currentFile = match[2];
                    oldLineNumber = 0;
                    newLineNumber = 0;
                }
                continue;
            }

            // 文件路径行: --- a/file 或 +++ b/file
            if (line.startsWith('---') || line.startsWith('+++')) {
                continue;
            }

            // 块头: @@ -oldStart,oldCount +newStart,newCount @@
            if (line.startsWith('@@')) {
                const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
                if (match) {
                    oldLineNumber = parseInt(match[1]) - 1;
                    newLineNumber = parseInt(match[3]) - 1;
                }
                continue;
            }

            if (!currentFile) {
                continue;
            }

            // 添加的行
            if (line.startsWith('+') && !line.startsWith('+++')) {
                newLineNumber++;
                lines.push({
                    file: currentFile,
                    lineNumber: newLineNumber,
                    content: line.substring(1),
                    type: 'added',
                    changeType: currentChangeType
                });
            }
            // 删除的行
            else if (line.startsWith('-') && !line.startsWith('---')) {
                oldLineNumber++;
                lines.push({
                    file: currentFile,
                    lineNumber: oldLineNumber,
                    content: line.substring(1),
                    type: 'removed',
                    changeType: currentChangeType
                });
            }
            // 上下文行
            else if (line.startsWith(' ')) {
                oldLineNumber++;
                newLineNumber++;
                lines.push({
                    file: currentFile,
                    lineNumber: newLineNumber,
                    content: line.substring(1),
                    type: 'context',
                    changeType: currentChangeType
                });
            }
        }

        return lines;
    }

    /**
     * 在diff中搜索
     */
    async searchInDiff(searchTerm: string, caseSensitive: boolean = false, useRegex: boolean = false): Promise<DiffLine[]> {
        const diffLines = await this.getParsedDiff();
        
        let regex: RegExp;
        try {
            if (useRegex) {
                // 使用正则表达式
                const flags = caseSensitive ? 'g' : 'gi';
                regex = new RegExp(searchTerm, flags);
            } else {
                // 转义特殊字符，作为普通文本搜索
                const escapedTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const flags = caseSensitive ? 'g' : 'gi';
                regex = new RegExp(escapedTerm, flags);
            }
        } catch (error: any) {
            throw new Error(`无效的正则表达式: ${error.message}`);
        }

        return diffLines.filter(line => {
            // 只搜索添加和删除的行，不搜索上下文
            if (line.type === 'context') {
                return false;
            }
            return regex.test(line.content);
        });
    }
}


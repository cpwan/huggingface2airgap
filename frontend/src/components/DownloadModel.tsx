'use client';

import { useState } from 'react';
import { listFiles } from '@huggingface/hub';
import { minimatch } from 'minimatch';

// Define the backend URL as a global variable
const BACKEND_URL = `wss://${window.location.hostname}:${window.location.port}/stream-model`;

interface File {
    path: string;
}

async function streamModelRepo(repoName: string, excludePatterns: string, hfToken: string, setProgress: (message: string) => void, setError: (message: string) => void) {
    let ws: WebSocket | null = null;
    try {
        // Step 1: Fetch commit hash for "main" revision
        const commitUrl = `https://huggingface.co/api/models/${repoName}/commits/main`;
        const commitResponse = await fetchWithRetry(commitUrl, 3, hfToken);
        if (!commitResponse) throw new Error('Failed to fetch commit data');
        const commitData = await commitResponse.json();
        const commitHash = commitData[0].id;

        // Step 2: List files in the repository using @huggingface/hub
        const patterns = excludePatterns.split(',').map(pattern => pattern.trim());
        const files: File[] = [];
        for await (const file of listFiles({ repo: { type: 'model', name: repoName } })) {
            if (!file.path.startsWith('.') && !patterns.some(pattern => minimatch(file.path, pattern))) { // Skip hidden and excluded files
                files.push(file);
            }
        }
        const totalFiles = files.length;
        setProgress(`Found ${totalFiles} files in ${repoName}`);

        // Step 3: Establish WebSocket connection
        ws = new WebSocket(BACKEND_URL); // Use the global variable for the backend URL
        await new Promise<void>((resolve, reject) => {
            ws!.onopen = () => resolve();
            ws!.onerror = () => reject(new Error('WebSocket connection failed'));
        });
        setProgress('Connected to the server');

        // Step 4: Stream each file with retry logic
        let uploaded = 0;
        for (const file of files) {
            const fileUrl = `https://huggingface.co/${repoName}/resolve/main/${file.path}`;
            const fileName = file.path.split('/').pop()!;

            await streamFile(fileUrl, fileName, repoName, commitHash, ws, hfToken, setProgress);
            uploaded++;
            setProgress(`Streamed: ${uploaded}/${totalFiles} - ${fileName}`);
            await new Promise(resolve => setTimeout(resolve, 500)); // Delay between files
        }

        setProgress(`All files from ${repoName} have been transferred!`);
    } catch (error: any) { /* eslint-disable-line @typescript-eslint/no-explicit-any */
        setError(`Error: ${error.message}`);
    } finally {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    }
}

async function streamFile(url: string, fileName: string, repoName: string, commitHash: string, ws: WebSocket, hfToken: string, setProgress: (message: string) => void) {
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        try {
            const response = await fetch(url, {
                headers: hfToken ? { Authorization: `Bearer ${hfToken}` } : {}
            });
            if (!response.ok) throw new Error(`Failed to fetch ${fileName}: ${response.statusText}`);

            const reader = response.body!.getReader();
            let received = 0;
            const totalSize = parseInt(response.headers.get('content-length') || '0', 10);

            // Send metadata to start the file
            ws.send(JSON.stringify({ file_name: fileName, repo_name: repoName, commit_hash: commitHash, action: 'start' }));

            // Stream chunks
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    ws.send(JSON.stringify({ action: 'end' }));
                    break;
                }
                received += value?.length || 0;
                ws.send(value);
                setProgress(`Streaming ${fileName}: ${(received / (1024 * 1024)).toFixed(2)} MB / ${(totalSize / (1024 * 1024)).toFixed(2)} MB`);
            }
            return; // Success, exit retry loop
        } catch (error: any) { /* eslint-disable-line @typescript-eslint/no-explicit-any */
            attempts++;
            if (attempts === maxAttempts) throw new Error(`Failed to stream ${fileName} after ${maxAttempts} attempts: ${error.message}`);
            setProgress(`Retrying ${fileName} (${attempts}/${maxAttempts})`);
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempts))); // Exponential backoff
        }
    }
}

async function fetchWithRetry(url: string, maxAttempts: number, hfToken: string) {
    let attempts = 0;
    while (attempts < maxAttempts) {
        try {
            const response = await fetch(url, {
                headers: hfToken ? { Authorization: `Bearer ${hfToken}` } : {}
            });
            if (response.ok) return response;
            throw new Error(`HTTP ${response.status}`);
        } catch (error) {
            attempts++;
            if (attempts === maxAttempts) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempts)));
        }
    }
}

export default function DownloadModel() {
    const [repoName, setRepoName] = useState('facebook/opt-125m');
    const [excludePatterns, setExcludePatterns] = useState('*.msgpack, *.h5');
    const [hfToken, setHfToken] = useState('');
    const [progress, setProgress] = useState('');
    const [error, setError] = useState('');

    const handleDownload = () => {
        if (repoName) {
            setProgress('');
            setError('');
            streamModelRepo(repoName, excludePatterns, hfToken, setProgress, setError);
        }
    };

    return (
        <div className="p-5 font-sans max-w-lg mx-auto">
            <h1 className="text-2xl text-gray-800 mb-4">HuggingFace-{">"}Browser-{">"}Server</h1>
            <div className="mb-4">
                <label className="block text-gray-700 mb-2" htmlFor="repoName">Model Repository</label>
                <input
                    type="text"
                    id="repoName"
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value)}
                    placeholder="Enter model repo (e.g., bert-base-uncased)"
                    className="p-2 w-full border rounded"
                />
            </div>
            <div className="mb-4">
                <label className="block text-gray-700 mb-2" htmlFor="excludePatterns">Exclude Patterns</label>
                <input
                    type="text"
                    id="excludePatterns"
                    value={excludePatterns}
                    onChange={(e) => setExcludePatterns(e.target.value)}
                    placeholder="Enter exclude patterns (comma-separated)"
                    className="p-2 w-full border rounded"
                />
            </div>
            <div className="mb-4">
                <label className="block text-gray-700 mb-2" htmlFor="hfToken">Hugging Face Token</label>
                <input
                    type="text"
                    id="hfToken"
                    value={hfToken}
                    onChange={(e) => setHfToken(e.target.value)}
                    placeholder="Enter Hugging Face token (optional)"
                    className="p-2 w-full border rounded"
                />
            </div>
            <button
                onClick={handleDownload}
                className="p-2 w-full bg-blue-500 text-white rounded hover:bg-blue-700"
            >
                Stream to Server
            </button>
            {progress && <pre className="bg-gray-100 p-2 mt-4 rounded">{progress}</pre>}
            {error && <pre className="bg-red-100 text-red-700 p-2 mt-4 rounded">{error}</pre>}
        </div>
    );
}

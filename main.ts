type WatcherEventType = "updated";
class WatcherUpdatedEvent extends Event {
    constructor() { super("updated"); }
}

interface WatcherOptions {
    directories: string[];
    abortSignal?: AbortSignal;
    minimumDelayMS?: number;
}

class Watcher extends EventTarget {
    private directories: string[];
    private abortSignal?: AbortSignal;
    private minimumDelayMS: number;
    private watching = false;

    constructor(options: WatcherOptions) {
        super();
        this.directories = options.directories;
        this.abortSignal = options.abortSignal;
        this.minimumDelayMS = options.minimumDelayMS ?? 200;
    }

    watch(): Watcher {
        if (!this.watching) {
            this.watching = true;

            // Only honor the final callback (i.e. the last outstanding one)
            let outstanding = 0;
            const update = () => {
                if (--outstanding === 0) {
                    console.log(`Watch: notifying...`);
                    this.dispatchEvent(new WatcherUpdatedEvent());
                }
            };

            // Subscribe to file system changes
            const watcher = Deno.watchFs(this.directories, { recursive: true });
            (async () => {
                for await (const event of watcher) {
                    console.log(`Watch: ${event.kind} for ${event.paths.join(";")}`);
                    ++outstanding;
                    setTimeout(update, this.minimumDelayMS);
                }
            })();

            // Subscribe to abort signal, if provided
            if (this.abortSignal) {
                this.abortSignal.addEventListener("abort", () => {
                    console.log("Watch: aborting...");
                    watcher.close();
                    this.watching = false;
                });
            }
        }

        console.log(`Watch: monitoring ${this.directories.join(";")}`);

        return this;
    }

    addEventListener(type: WatcherEventType, listener: (event: WatcherUpdatedEvent) => void, options?: AddEventListenerOptions): void {
        super.addEventListener(type, listener, options);
    }

    removeEventListener(type: WatcherEventType, listener: (event: WatcherUpdatedEvent) => void): void {
        super.removeEventListener(type, listener);
    }
}

interface ServerOptions {
    root: string;
    port?: number;
    hostName?: string;
    watch?: boolean;
}

class Server {
    private root: string;
    private port: number;
    private hostName: string;
    private watcher?: Watcher;
    private reloadEventPath: string;
    private reloadScript: string;
    private reloadClients: WebSocket[] = [];
    private textDecoder = new TextDecoder();
    private textEncoder = new TextEncoder();

    constructor(options: ServerOptions) {
        this.root = options.root;
        this.port = options.port ?? 8888;
        this.hostName = options.hostName ?? "localhost";
        this.watcher = options.watch
            ? new Watcher({ directories: [this.root] })
            : undefined;

        this.reloadEventPath = "/.watch_n_serve/events";
        this.reloadScript = `<script>(new WebSocket("ws://${this.hostName}:${this.port}${this.reloadEventPath}")).addEventListener("message", function (event) { window.location.reload(); });</script>`;
    }

    serve(): Server {
        if (this.watcher) {
            this.watcher.addEventListener("updated", () => {
                for (const socket of this.reloadClients) {
                    try {
                        socket.send("updated");
                    } catch (_e) {
                        // Ignore errors and assume client is no longer active
                    }
                }
            });
        }

        const server = Deno.listen({
            hostname: this.hostName,
            port: this.port,
        });
        
        console.log(`Serve: listening on: http://${this.hostName}:${this.port}/`);
        
        (async () => {
            for await (const connection of server) {
                (async () => {
                    try {
                        const httpConnection = Deno.serveHttp(connection);
                        for await (const re of httpConnection) {
                            const url = new URL(re.request.url);
                            try {
                                if (this.watcher && url.pathname === this.reloadEventPath) {
                                    const { socket, response } = Deno.upgradeWebSocket(re.request);
                                    this.reloadClients.push(socket);
                                    socket.addEventListener("close", () => {
                                        this.reloadClients.splice(this.reloadClients.indexOf(socket), 1);
                                    });
                                    await re.respondWith(response);
                                } else {
                                    const path = this.root + (url.pathname.endsWith("/") ? url.pathname + "index.html" : url.pathname);
                                    let content = await Deno.readFile(path);
        
                                    let insertedAutomaticReloadingScript = false;
                                    if (this.watcher && path.endsWith(".html")) {
                                        // Insert reload script
                                        let text = this.textDecoder.decode(content);
                                        const index = text.lastIndexOf("</body>");
                                        if (index >= 0) {
                                            text = text.substr(0, index) + this.reloadScript + text.substr(index);
                                        } else {
                                            text += this.reloadScript;
                                        }
                                        content = this.textEncoder.encode(text);
                                        insertedAutomaticReloadingScript = true;
                                    }
        
                                    await re.respondWith(new Response(content, { status: 200 }));
                                    console.log(`  Serve: ${re.request.method} ${url.pathname} => ${path}${insertedAutomaticReloadingScript ? " (with auto-reload)" : ""}`);
                                }
                            } catch (_e) {
                                await re.respondWith(new Response("", { status: 404 }));
                                console.log(`  Serve: ${re.request.method} ${url.pathname} => (not found)`);
                            }
                        }
                    } catch (e) {
                        console.log(`  Serve: error: ${e}`);
                    }
                })();
            }
        })();

        if (this.watcher) {
            this.watcher.watch();
        }
        
        return this;
    }
}

const options = {
    root: Deno.args[0],
    port: 8888,
    hostname: "localhost",
};

(new Server({
    root: options.root,
    port: options.port,
    hostName: options.hostname,
    watch: true,
})).serve();

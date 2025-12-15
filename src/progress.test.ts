import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProgressReporter } from "./progress.js";
import type { OpencodeClient } from "./types.js";

describe("ProgressReporter", () => {
    let mockClient: OpencodeClient;
    let mockLogger: Record<string, any>;
    let reporter: ProgressReporter;

    beforeEach(() => {
        mockLogger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        };

        mockClient = {
            app: {
                log: vi.fn().mockResolvedValue(undefined),
            },
            session: {
                promptAsync: vi.fn(),
            }
        } as unknown as OpencodeClient;

        reporter = new ProgressReporter(mockClient, mockLogger as any);
    });

    it("should prefer client.app.log over console logger when available", async () => {
        await reporter.emit("test message", { level: "info" });

        // Should call app.log
        expect(mockClient.app.log).toHaveBeenCalledWith(expect.objectContaining({
            body: expect.objectContaining({
                message: expect.stringContaining("test message"),
                level: "info"
            })
        }));

        // Should NOT call console logger
        expect(mockLogger.info).not.toHaveBeenCalled();
    });

    it("should fallback to console logger if client.app.log is missing", async () => {
        // Remove app.log
        delete (mockClient as any).app;

        // Re-instantiate to be sure
        reporter = new ProgressReporter(mockClient, mockLogger as any);

        await reporter.emit("fallback message", { level: "info" });

        // Should call console logger
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("fallback message"));
    });

    it("should fallback to console logger if client.app.log fails", async () => {
        // Make app.log fail
        mockClient.app.log = vi.fn().mockRejectedValue(new Error("Log failed"));

        await reporter.emit("failure message", { level: "info" });

        // Should call console logger
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("failure message"));
    });
});

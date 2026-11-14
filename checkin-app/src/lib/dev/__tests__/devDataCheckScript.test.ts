jest.mock("@checkin/receipt", () => ({ getPrisma: jest.fn() }));
jest.mock("../dataCheck", () => ({
    runDevDataCheck: jest.fn().mockRejectedValue(new Error("connect ECONNREFUSED db.internal.invalid:5432")),
}));

describe("dev-data-check script", () => {
    it("prints a fixed failure message with no connection details", async () => {
        const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
        const exited = new Promise<number | undefined>((resolve) => {
            jest.spyOn(process, "exit").mockImplementation(((code?: number) => {
                resolve(code);
                return undefined as never;
            }) as typeof process.exit);
        });

        await import("../../../../scripts/dev-data-check");

        expect(await exited).toBe(1);
        expect(error.mock.calls).toEqual([["dev-data-check failed"]]);
    });
});

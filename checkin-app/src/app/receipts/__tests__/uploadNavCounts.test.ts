type Api = { upload: (form: FormData) => Promise<unknown> };
const { upload } = jest.requireActual<Api>("@checkin/receipt/components/api");

const respond = (status: number, body: unknown) =>
  jest.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe("receipt upload()", () => {
  const counted = jest.fn();
  beforeEach(() => window.addEventListener("nav-counts-mutated", counted));
  afterEach(() => {
    window.removeEventListener("nav-counts-mutated", counted);
    counted.mockReset();
  });

  it("tells the nav to refetch its counts after a successful upload", async () => {
    global.fetch = respond(200, { id: "r1" });
    await expect(upload(new FormData())).resolves.toEqual({ id: "r1" });
    expect(counted).toHaveBeenCalledTimes(1);
  });

  it("leaves the nav counts alone when the upload is refused", async () => {
    global.fetch = respond(400, { error: "A receipt file is required" });
    await expect(upload(new FormData())).rejects.toThrow("A receipt file is required");
    expect(counted).not.toHaveBeenCalled();
  });
});

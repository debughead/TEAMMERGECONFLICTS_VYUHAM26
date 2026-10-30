// Shared by both demo sites: shows exactly what the "site" received, like a real upload handler would.
// With ?autotest=<sample file>, simulates a user picking that file so the flow can run headless.
(function () {
  const input = document.querySelector('input[type="file"]');
  const log = document.getElementById("received");
  const received = [];

  async function describe(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const latin = Array.from(bytes.subarray(0, 4096), (b) => String.fromCharCode(b)).join("");
    return { name: file.name, type: file.type, size: file.size, hasExif: latin.includes("Exif\0\0"), hasGpsTag: /GPS/.test(latin) };
  }

  input.addEventListener("change", async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const d = await describe(f);
    received.push(d);
    const li = document.createElement("li");
    li.textContent = `Received ${d.name} (${d.size} bytes, ${d.type || "unknown type"})${d.hasExif ? " · contains EXIF" : ""} `;
    // Lets you open exactly what the "site" got, to check nothing hidden is left in it.
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f);
    a.download = `received-${f.name}`;
    a.textContent = "Download what the site received";
    li.appendChild(a);
    log.appendChild(li);
  });

  const auto = new URLSearchParams(location.search).get("autotest");
  if (auto) {
    setTimeout(async () => {
      const blob = await (await fetch(`/samples/${auto}`)).blob();
      const file = new File([blob], auto, { type: blob.type });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // Give the extension time to scan and (maybe) swap in a cleaned file, then report.
      setTimeout(() => {
        fetch("/__result", { method: "POST", body: JSON.stringify({ page: location.pathname, sample: auto, received, inputStillHolds: input.files.length }) });
      }, 20000);
    }, 1500);
  }
})();

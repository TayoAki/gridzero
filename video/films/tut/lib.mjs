// Shared by the tutorial captures: a signed-in person, and a way to save the page as it stands.
import { createRequire } from "node:module";
export const require = createRequire("/home/user/gridzero/tests/e2e/");
export const E2E = "/home/user/gridzero/tests/e2e/";
export const call = (name, input) => ({ tools: [{ id: `tu_${Math.random().toString(36).slice(2, 8)}`, name, input }], stop: "tool_use" });

export async function person(base, name) {
  let cookie = "";
  const api = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.match(/better-auth\.session_token=[^;]+/)?.[0] ?? cookie;
    return res;
  };
  const email = `${name.toLowerCase().replace(/\W+/g, ".")}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const r = await api("POST", "/api/auth/sign-up/email", { name, email, password: "correct-horse-9" });
  if (r.status !== 200) throw new Error("sign-up failed " + r.status);
  return { api, json: async (m, p, b) => (await api(m, p, b)).json(), cookie: () => cookie };
}

/** The shell as it is drawn right now: field values kept, the grid's canvas turned into a picture. */
export async function shot(page) {
  return page.evaluate(() => {
    const shell = document.querySelector(".gz-shell");
    const clone = shell.cloneNode(true);
    const a = shell.querySelectorAll("input, textarea, select, canvas"), b = clone.querySelectorAll("input, textarea, select, canvas");
    a.forEach((el, i) => {
      const c = b[i];
      if (el.tagName === "CANVAS") {
        const img = document.createElement("img");
        try { img.src = el.toDataURL("image/png"); } catch { return; }
        const r = el.getBoundingClientRect();
        img.className = el.className; img.setAttribute("style", `${el.getAttribute("style") ?? ""};width:${r.width}px;height:${r.height}px;display:block`);
        c.replaceWith(img);
      } else if (el.tagName === "TEXTAREA") c.textContent = el.value;
      else if (el.tagName === "SELECT") [...c.options].forEach((o, j) => (el.selectedIndex === j ? o.setAttribute("selected", "") : o.removeAttribute("selected")));
      else if (el.type === "radio" || el.type === "checkbox") (el.checked ? c.setAttribute("checked", "") : c.removeAttribute("checked"));
      else if (el.type !== "file" && el.type !== "password") c.setAttribute("value", el.value);
      else if (el.type === "password") c.setAttribute("value", "•".repeat(el.value.length));
    });
    return clone.outerHTML;
  });
}

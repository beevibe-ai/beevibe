const input = document.getElementById("backend");
const saveBtn = document.getElementById("save");
const saved = document.getElementById("saved");

(async () => {
  const { backendUrl } = await chrome.storage.local.get("backendUrl");
  input.value = backendUrl || "http://localhost:8787";
})();

saveBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ backendUrl: input.value.trim() });
  saved.textContent = "saved";
  setTimeout(() => (saved.textContent = ""), 1500);
});

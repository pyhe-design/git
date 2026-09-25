// Mounts SimpleMDE on the page form. External fetches are disabled:
// Font Awesome is served from /static and the spell checker (which pulls
// dictionaries from a CDN) is off.
(function () {
  "use strict";
  var textarea = document.getElementById("body_md");
  if (!textarea || typeof SimpleMDE === "undefined") return;

  var editor = new SimpleMDE({
    element: textarea,
    autoDownloadFontAwesome: false,
    spellChecker: false,
    forceSync: true,
    promptURLs: true,
    status: ["lines", "words"],
    toolbar: [
      "bold", "italic", "heading", "|",
      "quote", "unordered-list", "ordered-list", "|",
      "link", "image", "table", "|",
      "preview", "side-by-side", "fullscreen", "|", "guide"
    ]
  });

  // The hidden textarea can't satisfy `required`/focus; keep form submit robust.
  textarea.removeAttribute("required");
  textarea.form.addEventListener("submit", function () {
    textarea.value = editor.value();
  });
})();

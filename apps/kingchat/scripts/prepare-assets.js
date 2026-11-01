const path = require("node:path");
const sharp = require("sharp");

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const source = path.join(projectRoot, "assets", "guftin-icon.svg");
  const destination = path.join(projectRoot, "assets", "guftin-icon.png");

  await sharp(source)
    .resize(1024, 1024, { fit: "cover" })
    .png({ compressionLevel: 9 })
    .toFile(destination);

  console.log("Generated Guftin 1024x1024 launcher and splash icon.");
}

main().catch((error) => {
  console.error("Could not generate Guftin app icon:", error);
  process.exitCode = 1;
});

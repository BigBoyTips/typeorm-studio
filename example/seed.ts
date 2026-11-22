import { AppDataSource, Post, Profile, Role, Tag, User } from "./data-source";

async function main() {
  await AppDataSource.initialize();
  await AppDataSource.synchronize(true);
  const tags = await AppDataSource.getRepository(Tag).save(["typescript", "orm", "sql", "news"].map((label) => ({ label })));
  const names = ["Ada Lovelace", "Alan Turing", "Grace Hopper", "Edsger Dijkstra", "Barbara Liskov", "Donald Knuth", "Linus Torvalds", "Margaret Hamilton"];
  for (const [i, name] of names.entries()) {
    const profile = await AppDataSource.getRepository(Profile).save({ bio: i % 3 ? `Hi, I'm ${name.split(" ")[0]}` : null, settings: { theme: i % 2 ? "dark" : "light" } });
    const user = await AppDataSource.getRepository(User).save({
      email: `${name.split(" ")[0].toLowerCase()}@example.com`, name,
      role: [Role.Admin, Role.Editor, Role.Reader][i % 3], active: i % 4 !== 0, profile,
    });
    for (let p = 0; p < 1 + (i % 4) * 4; p++) {
      await AppDataSource.getRepository(Post).save({
        title: `${name.split(" ")[1]}'s post #${p + 1}`, body: p % 2 ? "Lorem ipsum dolor sit amet." : null,
        published: p % 3 === 0, views: (i + 1) * (p + 3) * 7, author: user,
        tags: tags.filter((_, ti) => (ti + p) % 2 === 0),
      });
    }
  }
  console.log("seeded");
  await AppDataSource.destroy();
}
main();

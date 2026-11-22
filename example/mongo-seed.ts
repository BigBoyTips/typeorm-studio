import { MongoDataSource, Post, Role, User } from "./mongo-data-source";

async function main() {
  await MongoDataSource.initialize();
  const users = MongoDataSource.getMongoRepository(User);
  const posts = MongoDataSource.getMongoRepository(Post);
  await posts.deleteMany({});
  await users.deleteMany({});
  const tags = ["typescript", "orm", "mongodb", "news"];
  const names = ["Ada Lovelace", "Alan Turing", "Grace Hopper", "Edsger Dijkstra", "Barbara Liskov", "Donald Knuth", "Linus Torvalds", "Margaret Hamilton"];
  for (const [i, name] of names.entries()) {
    const user = await users.save(
      users.create({
        email: `${name.split(" ")[0].toLowerCase()}@example.com`, name,
        role: [Role.Admin, Role.Editor, Role.Reader][i % 3], active: i % 4 !== 0,
        profile: { bio: i % 3 ? `Hi, I'm ${name.split(" ")[0]}` : null, theme: i % 2 ? "dark" : "light" },
      }),
    );
    for (let p = 0; p < 1 + (i % 4) * 4; p++) {
      await posts.save(
        posts.create({
          title: `${name.split(" ")[1]}'s post #${p + 1}`, body: p % 2 ? "Lorem ipsum dolor sit amet." : null,
          published: p % 3 === 0, views: (i + 1) * (p + 3) * 7, authorId: user._id,
          tags: tags.filter((_, ti) => (ti + p) % 2 === 0),
        }),
      );
    }
  }
  console.log("seeded");
  await MongoDataSource.destroy();
}
main();

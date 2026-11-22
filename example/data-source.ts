import "reflect-metadata";
// Column types are explicit so this file also loads under esbuild/tsx, which does not emit decorator metadata.
import {
  Column, CreateDateColumn, DataSource, Entity, JoinTable, ManyToMany, ManyToOne,
  OneToMany, OneToOne, JoinColumn, PrimaryGeneratedColumn, Relation, UpdateDateColumn,
} from "typeorm";

export enum Role { Admin = "admin", Editor = "editor", Reader = "reader" }

@Entity()
export class Profile {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", nullable: true }) bio!: string | null;
  @Column({ type: "simple-json", nullable: true }) settings!: Record<string, unknown> | null;
  @OneToOne(() => User, (u) => u.profile) user!: Relation<User>;
}

@Entity()
export class User {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", unique: true }) email!: string;
  @Column({ type: "varchar" }) name!: string;
  @Column({ type: "simple-enum", enum: Role, default: Role.Reader }) role!: Role;
  @Column({ type: "boolean", default: true }) active!: boolean;
  @OneToOne(() => Profile, (p) => p.user, { nullable: true }) @JoinColumn() profile!: Relation<Profile> | null;
  @OneToMany(() => Post, (p) => p.author) posts!: Relation<Post[]>;
  @CreateDateColumn() createdAt!: Date;
}

@Entity()
export class Tag {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar" }) label!: string;
  @ManyToMany(() => Post, (p) => p.tags) posts!: Relation<Post[]>;
}

@Entity()
export class Post {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ type: "varchar" }) title!: string;
  @Column({ type: "text", nullable: true }) body!: string | null;
  @Column({ type: "boolean", default: false }) published!: boolean;
  @Column({ type: "integer", default: 0 }) views!: number;
  @ManyToOne(() => User, (u) => u.posts, { onDelete: "CASCADE" }) author!: Relation<User>;
  @ManyToMany(() => Tag, (t) => t.posts) @JoinTable() tags!: Relation<Tag[]>;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

const url = process.env.DATABASE_URL;

/** TypeORM's mssql driver takes no `url`: mssql://user:password@host:port/database */
function mssqlOptions(u: string) {
  const p = new URL(u);
  return {
    type: "mssql" as const,
    host: p.hostname,
    port: Number(p.port || 1433),
    username: decodeURIComponent(p.username),
    password: decodeURIComponent(p.password),
    database: p.pathname.slice(1),
    options: { trustServerCertificate: true },
  };
}

/**
 * SQLite by default; set DATABASE_URL=postgres://…, mysql://…, mariadb://… or
 * mssql://… to try another database. (MongoDB: see mongo-data-source.ts.)
 */
export const AppDataSource = new DataSource({
  ...(url?.startsWith("postgres")
    ? { type: "postgres" as const, url }
    : url?.startsWith("mariadb")
      ? { type: "mariadb" as const, url: url.replace(/^mariadb/, "mysql") }
      : url?.startsWith("mysql")
        ? { type: "mysql" as const, url }
        : url?.startsWith("mssql") || url?.startsWith("sqlserver")
          ? mssqlOptions(url)
          : { type: "better-sqlite3" as const, database: process.env.DB_FILE ?? __dirname + "/dev.sqlite" }),
  entities: [User, Profile, Post, Tag],
  synchronize: true,
});

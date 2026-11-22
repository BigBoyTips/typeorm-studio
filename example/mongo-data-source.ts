import "reflect-metadata";
// Column types are explicit so this file also loads under esbuild/tsx, which does not emit decorator metadata.
import { Column, ColumnType, CreateDateColumn, DataSource, Entity, ObjectId, ObjectIdColumn, UpdateDateColumn } from "typeorm";

/**
 * Marks a plain ObjectId reference field so Studio edits and filters it as an ObjectId.
 * TypeORM accepts any type name on MongoDB, but its ColumnType union does not list "objectId".
 */
const OBJECT_ID = "objectId" as unknown as ColumnType;

export enum Role { Admin = "admin", Editor = "editor", Reader = "reader" }

/** Embedded document: shown in Studio as `profile.bio`, `profile.theme`. */
export class Profile {
  @Column({ type: "string", nullable: true }) bio!: string | null;
  @Column({ type: "string", nullable: true }) theme!: string | null;
}

@Entity("users")
export class User {
  @ObjectIdColumn() _id!: ObjectId;
  @Column({ type: "string" }) email!: string;
  @Column({ type: "string" }) name!: string;
  @Column({ type: "enum", enum: Role, default: Role.Reader }) role!: Role;
  @Column({ type: "boolean", default: true }) active!: boolean;
  @Column(() => Profile) profile!: Profile;
  @CreateDateColumn({ type: "date" }) createdAt!: Date;
}

/** TypeORM has no relations on MongoDB: the author is referenced by ObjectId. */
@Entity("posts")
export class Post {
  @ObjectIdColumn() _id!: ObjectId;
  @Column({ type: "string" }) title!: string;
  @Column({ type: "string", nullable: true }) body!: string | null;
  @Column({ type: "boolean", default: false }) published!: boolean;
  @Column({ type: "number", default: 0 }) views!: number;
  @Column({ type: "array", nullable: true }) tags!: string[] | null;
  @Column({ type: OBJECT_ID }) authorId!: ObjectId;
  @CreateDateColumn({ type: "date" }) createdAt!: Date;
  @UpdateDateColumn({ type: "date" }) updatedAt!: Date;
}

/** MONGO_URL defaults to a local server: mongodb://127.0.0.1:27017/typeorm_studio_example */
export const MongoDataSource = new DataSource({
  type: "mongodb",
  url: process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/typeorm_studio_example",
  entities: [User, Post],
});

import argon2 from "argon2";
import {
  Arg,
  Ctx,
  Field,
  InputType,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from "type-graphql";
import { User } from "../entities/User";
import { MyContext } from "../types";

@InputType()
class UsernamePasswordInput {
  @Field(() => String)
  username: string;
  @Field(() => String)
  password: string;
}

@ObjectType()
class FieldError {
  @Field(() => String)
  field: string;

  @Field(() => String)
  message: string;
}

@ObjectType()
class UserResponse {
  @Field(() => [FieldError], { nullable: true })
  errors?: FieldError[];

  @Field(() => User, { nullable: true })
  user?: User;
}

@Resolver()
export class UserResolver {
  @Query(() => User, { nullable: true })
  async me(@Ctx() ctx: MyContext): Promise<User | null> {
    if (!ctx.req.session.userId) {
      return null;
    }

    const user = await ctx.em.findOne(User, { id: ctx.req.session.userId });
    if (!user) {
      return null;
    }

    return user;
  }

  @Mutation(() => UserResponse)
  async register(
    @Arg("options", () => UsernamePasswordInput) options: UsernamePasswordInput,
    @Ctx() ctx: MyContext
  ): Promise<UserResponse> {
    const tempUser = await ctx.em.findOne(User, { username: options.username });
    if (tempUser) {
      return {
        errors: [{ field: "username", message: "username not available" }],
      };
    }

    if (options.username.length <= 2) {
      return {
        errors: [
          {
            field: "username",
            message: "username must be atleast 3 characters long",
          },
        ],
      };
    }

    if (options.password.length <= 2) {
      return {
        errors: [
          {
            field: "password",
            message: "password must be atleast 3 characters long",
          },
        ],
      };
    }

    const hashedPassword = await argon2.hash(options.password);
    const user = ctx.em.create(User, {
      username: options.username,
      password: hashedPassword,
    });
    await ctx.em.persistAndFlush(user);

    return { user };
  }

  @Mutation(() => UserResponse)
  async login(
    @Arg("username", () => String) username: string,
    @Arg("password", () => String) password: string,
    @Ctx() ctx: MyContext
  ): Promise<UserResponse> {
    const user = await ctx.em.findOne(User, { username });
    if (!user) {
      return {
        errors: [{ field: "username", message: "username not found" }],
      };
    }

    const isPasswordValid = await argon2.verify(user.password, password);
    if (!isPasswordValid) {
      return {
        errors: [{ field: "password", message: "incorrect password" }],
      };
    }

    ctx.req.session!.userId = user.id;

    return { user };
  }
}

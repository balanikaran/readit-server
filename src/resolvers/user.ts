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
import { v4 } from "uuid";
import { COOKIE_NAME, FORGOT_PASSWORD_PREFIX } from "../constants";
import { User } from "../entities/User";
import { MyContext } from "../types";
import { sendEmail } from "../utils/sendEmail";
import { validateEmail } from "../utils/validateEmail";

@InputType()
class EmailUsernamePasswordInput {
  @Field(() => String)
  email: string;
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
    @Arg("options", () => EmailUsernamePasswordInput)
    options: EmailUsernamePasswordInput,
    @Ctx() ctx: MyContext
  ): Promise<UserResponse> {
    // checking for valid email
    if (!validateEmail(options.email)) {
      return {
        errors: [{ field: "email", message: "invalid email format" }],
      };
    }

    // checking email already in use for some account/username
    let tempUser = await ctx.em.findOne(User, { email: options.email });
    if (tempUser) {
      return {
        errors: [{ field: "email", message: "email already in use" }],
      };
    }

    // checking for username to not contain @ sign
    if (options.username.includes("@")) {
      return {
        errors: [
          { field: "username", message: "username cannot contain '@' sign" },
        ],
      };
    }

    // checking username availability
    tempUser = await ctx.em.findOne(User, { username: options.username });
    if (tempUser) {
      return {
        errors: [{ field: "username", message: "username not available" }],
      };
    }

    // checking for username length
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

    // checking for password length
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
      email: options.email,
      username: options.username,
      password: hashedPassword,
    });
    await ctx.em.persistAndFlush(user);

    // add session
    // to keep people logged in
    ctx.req.session!.userId = user.id;

    return { user };
  }

  @Mutation(() => UserResponse)
  async login(
    @Arg("usernameOrEmail", () => String) usernameOrEmail: string,
    @Arg("password", () => String) password: string,
    @Ctx() ctx: MyContext
  ): Promise<UserResponse> {
    let user = null;
    // checking if email entered
    if (validateEmail(usernameOrEmail)) {
      user = await ctx.em.findOne(User, { email: usernameOrEmail });
    } else {
      user = await ctx.em.findOne(User, { username: usernameOrEmail });
    }

    if (!user) {
      return {
        errors: [
          { field: "usernameOrEmail", message: "username/email not found" },
        ],
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

  @Mutation(() => Boolean)
  async logout(@Ctx() ctx: MyContext): Promise<Boolean> {
    return new Promise((resolve) =>
      ctx.req.session.destroy((err) => {
        ctx.res.clearCookie(COOKIE_NAME);
        if (err) {
          console.log("unable to logout/destroy session: ", err);
          resolve(false);
          return;
        }

        resolve(true);
      })
    );
  }

  @Mutation(() => Boolean)
  async forgotPassword(@Ctx() ctx: MyContext, @Arg("email") email: string) {
    const user = await ctx.em.findOne(User, { email });

    if (!user) {
      // the email is not in db
      return true;
    }

    const token = v4();
    await ctx.redis.set(
      FORGOT_PASSWORD_PREFIX + token,
      user.id,
      "ex",
      1000 * 60 * 60 * 24
    ); // 1 day
    const htmlMessage = `<a href="http://localhost:3000/changePassword/${token}">reset password here</a>`;
    sendEmail(email, htmlMessage);

    return true;
  }

  @Mutation(() => UserResponse)
  async changePassword(
    @Arg("token") token: string,
    @Arg("newPassword") newPassword: string,
    @Ctx() ctx: MyContext
  ): Promise<UserResponse> {
    // check for password length
    if (newPassword.length <= 2) {
      return {
        errors: [
          {
            field: "newPassword",
            message: "password must be atleast 3 characters long",
          },
        ],
      };
    }

    const key = FORGOT_PASSWORD_PREFIX + token;
    const userId = await ctx.redis.get(key);

    // check if we got the valid token
    if (!userId) {
      return {
        errors: [{ field: "token", message: "token expired" }],
      };
    }

    const user = await ctx.em.findOne(User, { id: parseInt(userId) });

    if (!user) {
      return {
        errors: [{ field: "token", message: "user no longer exists" }],
      };
    }

    const hashedNewPassword = await argon2.hash(newPassword);
    user.password = hashedNewPassword;

    await ctx.em.persistAndFlush(user);

    await ctx.redis.del(key);

    ctx.req.session.userId = user.id;

    return { user };
  }
}

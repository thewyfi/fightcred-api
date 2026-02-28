CREATE TABLE `credibility_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`fightId` int NOT NULL,
	`predictionId` int NOT NULL,
	`winnerPoints` int NOT NULL DEFAULT 0,
	`finishTypePoints` int NOT NULL DEFAULT 0,
	`methodPoints` int NOT NULL DEFAULT 0,
	`bonusPoints` int NOT NULL DEFAULT 0,
	`totalPoints` int NOT NULL DEFAULT 0,
	`breakdown` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `credibility_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`shortName` varchar(128),
	`eventDate` timestamp NOT NULL,
	`venue` varchar(255),
	`location` varchar(255),
	`status` enum('upcoming','live','completed') NOT NULL DEFAULT 'upcoming',
	`ufcEventId` varchar(128),
	`imageUrl` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `fights` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventId` int NOT NULL,
	`fighter1Name` varchar(128) NOT NULL,
	`fighter1Record` varchar(32),
	`fighter1ImageUrl` text,
	`fighter2Name` varchar(128) NOT NULL,
	`fighter2Record` varchar(32),
	`fighter2ImageUrl` text,
	`weightClass` varchar(64),
	`cardSection` enum('main','prelim','early_prelim') NOT NULL DEFAULT 'main',
	`isTitleFight` boolean NOT NULL DEFAULT false,
	`isMainEvent` boolean NOT NULL DEFAULT false,
	`odds1` int,
	`odds2` int,
	`oddsUpdatedAt` timestamp,
	`status` enum('upcoming','live','completed','cancelled') NOT NULL DEFAULT 'upcoming',
	`scheduledStartTime` timestamp,
	`winner` varchar(128),
	`finishType` enum('finish','decision'),
	`method` enum('tko_ko','submission','decision','draw','nc'),
	`round` int,
	`fightTime` varchar(16),
	`oddsApiEventId` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `fights_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `predictions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`fightId` int NOT NULL,
	`pickedWinner` varchar(128) NOT NULL,
	`pickedFinishType` enum('finish','decision'),
	`pickedMethod` enum('tko_ko','submission'),
	`isLocked` boolean NOT NULL DEFAULT false,
	`status` enum('pending','correct','wrong','partial') NOT NULL DEFAULT 'pending',
	`winnerPoints` int NOT NULL DEFAULT 0,
	`finishTypePoints` int NOT NULL DEFAULT 0,
	`methodPoints` int NOT NULL DEFAULT 0,
	`bonusPoints` int NOT NULL DEFAULT 0,
	`totalPoints` int NOT NULL DEFAULT 0,
	`oddsAtPrediction` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `predictions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_fighter_stats` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`fighterName` varchar(128) NOT NULL,
	`totalPicks` int NOT NULL DEFAULT 0,
	`correctPicks` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_fighter_stats_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_profiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`username` varchar(64) NOT NULL,
	`displayName` varchar(128),
	`credibilityScore` int NOT NULL DEFAULT 0,
	`tier` enum('rookie','contender','champion','goat') NOT NULL DEFAULT 'rookie',
	`totalPicks` int NOT NULL DEFAULT 0,
	`correctPicks` int NOT NULL DEFAULT 0,
	`correctFinishPicks` int NOT NULL DEFAULT 0,
	`totalFinishPicks` int NOT NULL DEFAULT 0,
	`correctMethodPicks` int NOT NULL DEFAULT 0,
	`totalMethodPicks` int NOT NULL DEFAULT 0,
	`correctUnderdogPicks` int NOT NULL DEFAULT 0,
	`totalUnderdogPicks` int NOT NULL DEFAULT 0,
	`currentStreak` int NOT NULL DEFAULT 0,
	`bestStreak` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_profiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_profiles_userId_unique` UNIQUE(`userId`),
	CONSTRAINT `user_profiles_username_unique` UNIQUE(`username`)
);

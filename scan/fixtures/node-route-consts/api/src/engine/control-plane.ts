import express from 'express';
import {
	NESTED_PATH,
	RESOLVE_PATH as CREDENTIALS_PATH,
	STATUS_CALLBACK_PATH,
} from './engine.constants';
import { SHARED_PATH } from '@/shared';

const app = express();
app.post(STATUS_CALLBACK_PATH, (req, res) => res.end());
app.post(CREDENTIALS_PATH, handler);
app.post(NESTED_PATH, handler);
app.get(SHARED_PATH, handler);

function handler() {}
